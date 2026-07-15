package websocket

import (
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"log"
	"net/http"
	"sync/atomic"
	"time"

	"carrot-streaming-media/internal/media"

	gorilla "github.com/gorilla/websocket"
)

var upgrader = gorilla.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// Server handles WebSocket connections for browser streaming
type Server struct {
	streamMgr *media.StreamManager
	port      string
	connCount atomic.Int32
	server    *http.Server
	tlsConfig *tls.Config // nil = plain HTTP
	webDir    string      // web static files directory
}

// NewServer creates a new WebSocket streaming server
// If tlsConfig is nil, the server uses plain HTTP (ws://).
// If tlsConfig is provided, the server uses HTTPS (wss://).
func NewServer(port string, streamMgr *media.StreamManager, tlsConfig *tls.Config, webDir string) *Server {
	return &Server{
		port:      port,
		streamMgr: streamMgr,
		tlsConfig: tlsConfig,
		webDir:    webDir,
	}
}

// Start starts the WebSocket server
func (s *Server) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWebSocket)

	// Also serve web files for easy access via HTTP
	fs := http.FileServer(http.Dir(s.webDir))
	mux.Handle("/", fs)

	s.server = &http.Server{
		Addr:      ":" + s.port,
		Handler:   mux,
		TLSConfig: s.tlsConfig,
	}

	protocol := "HTTP"
	scheme := "ws"
	if s.tlsConfig != nil {
		protocol = "HTTPS"
		scheme = "wss"
	}

	log.Printf("[WebSocket] Starting server on :%s (%s/%s)", s.port, protocol, scheme)

	go func() {
		var err error
		if s.tlsConfig != nil {
			err = s.server.ListenAndServeTLS("", "")
		} else {
			err = s.server.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			log.Printf("[WebSocket] Server error: %v", err)
		}
	}()
	return nil
}

// Stop stops the WebSocket server
func (s *Server) Stop() {
	if s.server != nil {
		s.server.Close()
		log.Println("[WebSocket] Server stopped")
	}
}

// handleWebSocket handles incoming WebSocket connections
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WebSocket] Upgrade failed: %v", err)
		return
	}

	s.connCount.Add(1)
	connID := fmt.Sprintf("ws-%d", s.connCount.Load())

	// Parse stream URL parameters — support three modes:
	//   videoUrl=xxx  → video-only connection
	//   audioUrl=xxx  → audio-only connection
	//   url=xxx       → combined video+audio (backwards compatibility)
	videoURL := r.URL.Query().Get("videoUrl")
	audioURL := r.URL.Query().Get("audioUrl")
	combinedURL := r.URL.Query().Get("url")

	var streamURL string
	var wantsVideo, wantsAudio bool

	switch {
	case videoURL != "" && audioURL != "":
		// Both specified individually — this is unusual; treat as two paths
		log.Printf("[WebSocket] %s from %s: both videoUrl and audioUrl provided, using videoUrl=%s",
			connID, r.RemoteAddr, videoURL)
		streamURL = videoURL
		wantsVideo = true
	case videoURL != "":
		streamURL = videoURL
		wantsVideo = true
		log.Printf("[WebSocket] %s from %s: video-only connection, url=%s", connID, r.RemoteAddr, streamURL)
	case audioURL != "":
		streamURL = audioURL
		wantsAudio = true
		log.Printf("[WebSocket] %s from %s: audio-only connection, url=%s", connID, r.RemoteAddr, streamURL)
	case combinedURL != "":
		streamURL = combinedURL
		wantsVideo = true
		wantsAudio = true
		log.Printf("[WebSocket] %s from %s: combined connection, url=%s", connID, r.RemoteAddr, streamURL)
	default:
		log.Printf("[WebSocket] %s from %s rejected: missing url/videoUrl/audioUrl parameter", connID, r.RemoteAddr)
		conn.WriteMessage(gorilla.CloseMessage, []byte("missing url parameter"))
		conn.Close()
		s.connCount.Add(-1)
		return
	}

	// Get or create the stream by path
	stream := s.streamMgr.GetOrCreateStream(streamURL)

	s.handleConnection(conn, connID, stream, wantsVideo, wantsAudio)
}

// handleConnection manages a single WebSocket connection for a specific stream
func (s *Server) handleConnection(conn *gorilla.Conn, connID string, stream *media.Stream, wantsVideo, wantsAudio bool) {
	defer func() {
		s.connCount.Add(-1)
		conn.Close()
	}()

	// Wait for relevant codec config(s) to be ready
	waitStart := time.Now()
	for {
		videoReady := !wantsVideo || stream.HasConfig()
		audioReady := !wantsAudio || stream.HasAudioConfig()
		if videoReady && audioReady {
			break
		}
		if time.Since(waitStart) > 30*time.Second {
			log.Printf("[WebSocket] Timeout waiting for stream config for %s", connID)
			conn.WriteMessage(gorilla.CloseMessage, []byte("timeout waiting for stream"))
			return
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Send video codec config if this connection wants video
	if wantsVideo {
		configMsg := stream.BuildCodecConfigMessage()
		if configMsg != nil {
			log.Printf("[WebSocket] Sending video config to %s (%d bytes)", connID, len(configMsg))
			if err := conn.WriteMessage(gorilla.BinaryMessage, configMsg); err != nil {
				log.Printf("[WebSocket] Failed to send video config to %s: %v", connID, err)
				return
			}
			log.Printf("[WebSocket] Sent video codec config to %s (msgType=%d, payloadLen=%d)",
				connID, binary.BigEndian.Uint32(configMsg[0:4]), binary.BigEndian.Uint32(configMsg[8:12]))
		} else {
			log.Printf("[WebSocket] WARNING: No video config available for %s (hasConfig=%v)",
				connID, stream.HasConfig())
		}
	}

	// Send audio codec config if this connection wants audio
	if wantsAudio {
		audioConfigMsg := stream.BuildAudioCodecConfigMessage()
		if audioConfigMsg != nil {
			if err := conn.WriteMessage(gorilla.BinaryMessage, audioConfigMsg); err != nil {
				log.Printf("[WebSocket] Failed to send audio config to %s: %v", connID, err)
				return
			}
			log.Printf("[WebSocket] Sent audio codec config to %s", connID)
		}
	}

	// Register as subscriber with the appropriate preferences
	sub := stream.AddSubscriber(connID, wantsVideo, wantsAudio)
	defer stream.RemoveSubscriber(connID)

	log.Printf("[WebSocket] %s: subscribed, waiting for frames. Stream has %d subscribers", connID, stream.SubscriberCount())

	var frameCount int
	for {
		select {
		case <-sub.Done:
			return
		case frame, ok := <-sub.FrameChan:
			if !ok {
				return
			}
			if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
				return
			}
			if err := conn.WriteMessage(gorilla.BinaryMessage, frame); err != nil {
				log.Printf("[WebSocket] Write error to %s: %v", connID, err)
				return
			}
			frameCount++
			if frameCount <= 3 || frameCount%100 == 0 {
				msgType := binary.BigEndian.Uint32(frame[0:4])
				payloadLen := binary.BigEndian.Uint32(frame[8:12])
				log.Printf("[WebSocket] Forwarded frame #%d to %s: msgType=%d payloadLen=%d totalLen=%d",
					frameCount, connID, msgType, payloadLen, len(frame))
			}
		}
	}
}

// ConnectionCount returns the number of active WebSocket connections
func (s *Server) ConnectionCount() int {
	return int(s.connCount.Load())
}
