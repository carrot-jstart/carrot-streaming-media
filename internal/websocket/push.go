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

// PushServer handles WebSocket push from browsers (port 7778).
// Supports both video (?videoUrl=xxx) and audio (?audioUrl=xxx) push.
type PushServer struct {
	streamMgr *media.StreamManager
	port      string
	connCount atomic.Int32
	server    *http.Server
	tlsConfig *tls.Config // nil = plain WS
	webDir    string      // web static files directory (served on HTTP for push page)
}

// NewPushServer creates a new push server.
// If tlsConfig is nil, the server uses plain WS.
// If tlsConfig is provided, the server uses WSS.
// webDir is the static files directory (served on HTTP so push.html works without cert issues).
func NewPushServer(port string, streamMgr *media.StreamManager, tlsConfig *tls.Config, webDir string) *PushServer {
	return &PushServer{
		port:      port,
		streamMgr: streamMgr,
		tlsConfig: tlsConfig,
		webDir:    webDir,
	}
}

// Start starts the push server.
func (s *PushServer) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handlePush)

	// Serve static files (push.html etc.) on HTTP for easy push page access
	// without WSS cert issues during development.
	if s.webDir != "" {
		fs := http.FileServer(http.Dir(s.webDir))
		mux.Handle("/", fs)
	}

	s.server = &http.Server{
		Addr:      ":" + s.port,
		Handler:   mux,
		TLSConfig: s.tlsConfig,
	}

	protocol := "WS"
	if s.tlsConfig != nil {
		protocol = "WSS"
	}

	log.Printf("[Push] Starting push server on :%s (%s)", s.port, protocol)

	go func() {
		var err error
		if s.tlsConfig != nil {
			err = s.server.ListenAndServeTLS("", "")
		} else {
			err = s.server.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			log.Printf("[Push] Server error: %v", err)
		}
	}()
	return nil
}

// Stop stops the push server.
func (s *PushServer) Stop() {
	if s.server != nil {
		s.server.Close()
		log.Println("[Push] Server stopped")
	}
}

// handlePush routes incoming push connections.
func (s *PushServer) handlePush(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[Push] Upgrade failed: %v", err)
		return
	}

	s.connCount.Add(1)
	connID := fmt.Sprintf("push-%d", s.connCount.Load())

	videoURL := r.URL.Query().Get("videoUrl")
	audioURL := r.URL.Query().Get("audioUrl")
	combinedURL := r.URL.Query().Get("url")

	var streamURL string
	var pushType string // "video", "audio"

	switch {
	case videoURL != "":
		streamURL = videoURL
		pushType = "video"
	case audioURL != "":
		streamURL = audioURL
		pushType = "audio"
	case combinedURL != "":
		streamURL = combinedURL
		pushType = "audio" // default to audio
	default:
		log.Printf("[Push] %s from %s rejected: missing videoUrl or audioUrl parameter", connID, r.RemoteAddr)
		conn.WriteMessage(gorilla.CloseMessage, []byte("missing parameter"))
		conn.Close()
		s.connCount.Add(-1)
		return
	}

	log.Printf("[Push] New push: %s from %s, type=%s, url=%s", connID, r.RemoteAddr, pushType, streamURL)
	stream := s.streamMgr.GetOrCreateStream(streamURL)

	switch pushType {
	case "video":
		s.handleVideoPush(conn, connID, stream)
	case "audio":
		s.handleAudioPush(conn, connID, stream)
	}
}

// ---------------------------------------------------------------------------
// Audio push
// ---------------------------------------------------------------------------

func (s *PushServer) handleAudioPush(conn *gorilla.Conn, connID string, stream *media.Stream) {
	// Auto-set AAC config so playback clients know the format
	asc := []byte{0x12, 0x08} // AAC-LC, 44100Hz, mono
	stream.SetAudioConfig(media.AudioCodecAAC, 44100, 1, asc)
	log.Printf("[Push] %s: set AAC config (44100Hz, mono)", connID)

	var frameIndex int64
	var t0 time.Time

	defer func() {
		s.connCount.Add(-1)
		conn.Close()
		log.Printf("[Push] Audio push disconnected: %s (%d frames)", connID, frameIndex)
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}

		if t0.IsZero() {
			t0 = time.Now()
		}
		frameIndex++
		timestampMs := uint32(time.Since(t0).Milliseconds())

		stream.BroadcastAudioData(msg, timestampMs)

		if frameIndex%100 == 0 {
			log.Printf("[Push] %s: pushed %d audio frames", connID, frameIndex)
		}
	}
}

// ---------------------------------------------------------------------------
// Video push
// ---------------------------------------------------------------------------

// Video push protocol (binary messages):
//
// Message 1 (config, sent by browser once):
//   [4 bytes: sps_length][sps bytes][4 bytes: pps_length][pps bytes]
//   [4 bytes: width][4 bytes: height]
//
// Message 2+ (video frames):
//   [4 bytes: timestamp_ms][1 byte: is_keyframe(0/1)]
//   [remaining: H.264 AVCC data (4-byte NALU length prefix + NALU)]

func (s *PushServer) handleVideoPush(conn *gorilla.Conn, connID string, stream *media.Stream) {
	var frameIndex int64
	var t0 time.Time
	configDone := false

	defer func() {
		s.connCount.Add(-1)
		conn.Close()
		log.Printf("[Push] Video push disconnected: %s (%d frames)", connID, frameIndex)
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}

		if !configDone {
			log.Printf("[Push] %s: received config message (%d bytes)", connID, len(msg))
			if err := s.handleVideoConfig(stream, msg, connID); err != nil {
				log.Printf("[Push] %s: invalid video config: %v", connID, err)
				return
			}
			configDone = true
			if t0.IsZero() {
				t0 = time.Now()
			}
			log.Printf("[Push] %s: config processed successfully, stream has config=%v", connID, stream.HasConfig())
			continue
		}

		if t0.IsZero() {
			t0 = time.Now()
		}
		frameIndex++

		// Parse frame header
		if len(msg) < 5 {
			log.Printf("[Push] %s: frame too short (%d bytes), skipping", connID, len(msg))
			continue
		}
		timestampMs := binary.BigEndian.Uint32(msg[0:4])
		isKeyFrame := msg[4] != 0
		frameData := msg[5:]

		if frameIndex == 1 {
			t0 = time.Now()
		}
		stream.BroadcastVideoData(frameData, timestampMs, isKeyFrame)

		if frameIndex <= 3 || frameIndex%100 == 0 {
			log.Printf("[Push] %s: frame #%d key=%v ts=%d dataLen=%d", connID, frameIndex, isKeyFrame, timestampMs, len(frameData))
		}
	}
}

// handleVideoConfig parses the first message from browser: SPS + PPS + resolution.
func (s *PushServer) handleVideoConfig(stream *media.Stream, msg []byte, connID string) error {
	offset := 0
	if len(msg) < 4 {
		return fmt.Errorf("message too short for SPS length")
	}
	spsLen := int(binary.BigEndian.Uint32(msg[offset:]))
	offset += 4
	if offset+spsLen > len(msg) {
		return fmt.Errorf("SPS length exceeds message")
	}
	sps := msg[offset : offset+spsLen]
	offset += spsLen

	if offset+4 > len(msg) {
		return fmt.Errorf("message too short for PPS length")
	}
	ppsLen := int(binary.BigEndian.Uint32(msg[offset:]))
	offset += 4
	if offset+ppsLen > len(msg) {
		return fmt.Errorf("PPS length exceeds message")
	}
	pps := msg[offset : offset+ppsLen]
	offset += ppsLen

	if offset+8 > len(msg) {
		return fmt.Errorf("message too short for resolution")
	}
	width := int(binary.BigEndian.Uint32(msg[offset:]))
	height := int(binary.BigEndian.Uint32(msg[offset+4:]))

	stream.SetVideoConfig(sps, pps, width, height)
	log.Printf("[Push] %s: set H.264 config %dx%d (SPS=%d, PPS=%d)",
		connID, width, height, spsLen, ppsLen)
	return nil
}

// PushConnectionCount returns the number of active push connections.
func (s *PushServer) PushConnectionCount() int {
	return int(s.connCount.Load())
}
