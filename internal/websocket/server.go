package websocket

import (
	"crypto/tls"
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

	// Parse stream URL from query parameter
	streamURL := r.URL.Query().Get("url")
	if streamURL == "" {
		log.Printf("[WebSocket] %s from %s rejected: missing url parameter", connID, r.RemoteAddr)
		conn.WriteMessage(gorilla.CloseMessage, []byte("missing url parameter"))
		conn.Close()
		s.connCount.Add(-1)
		return
	}
	log.Printf("[WebSocket] New connection: %s from %s, url=%s", connID, r.RemoteAddr, streamURL)

	// Get or create the stream by path
	stream := s.streamMgr.GetOrCreateStream(streamURL)

	s.handleConnection(conn, connID, stream)
}

// handleConnection manages a single WebSocket connection for a specific stream
func (s *Server) handleConnection(conn *gorilla.Conn, connID string, stream *media.Stream) {
	defer func() {
		s.connCount.Add(-1)
		conn.Close()
	}()

	// Wait for codec config to be available
	waitStart := time.Now()
	for !stream.HasConfig() {
		if time.Since(waitStart) > 30*time.Second {
			log.Printf("[WebSocket] Timeout waiting for stream config for %s", connID)
			conn.WriteMessage(gorilla.CloseMessage, []byte("timeout waiting for stream"))
			return
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Send codec config first
	configMsg := stream.BuildCodecConfigMessage()
	if configMsg != nil {
		if err := conn.WriteMessage(gorilla.BinaryMessage, configMsg); err != nil {
			log.Printf("[WebSocket] Failed to send config to %s: %v", connID, err)
			return
		}
		log.Printf("[WebSocket] Sent codec config to %s", connID)
	}

	// Register as subscriber
	sub := stream.AddSubscriber(connID)
	defer stream.RemoveSubscriber(connID)

	log.Printf("[WebSocket] Started sending video to %s", connID)

	for {
		select {
		case <-sub.Done:
			return
		case frame, ok := <-sub.VideoChan:
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
		}
	}
}

// ConnectionCount returns the number of active WebSocket connections
func (s *Server) ConnectionCount() int {
	return int(s.connCount.Load())
}
