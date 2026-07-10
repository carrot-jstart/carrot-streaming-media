package rtmp

import (
	"log"
	"strings"
	"time"

	"carrot-streaming-media/internal/media"

	"github.com/nareix/joy4/av"
	"github.com/nareix/joy4/format/rtmp"
)

// Server handles RTMP stream ingestion from ffmpeg
type Server struct {
	rtmpServer *rtmp.Server
	streamMgr  *media.StreamManager
	port       string
}

// NewServer creates a new RTMP server
func NewServer(port string, streamMgr *media.StreamManager) *Server {
	return &Server{
		port:      port,
		streamMgr: streamMgr,
	}
}

// extractStreamPath extracts the stream key from an RTMP URL.
// e.g. "rtmp://host:1935/live/stream" -> "live/stream"
func extractStreamPath(rawURL string) string {
	// The joy4 library provides the URL in conn.URL.String() or conn.URL.Path
	// We need to parse it to get the path after the app name
	if idx := strings.Index(rawURL, "://"); idx >= 0 {
		rawURL = rawURL[idx+3:]
	}
	// Skip host:port
	if idx := strings.Index(rawURL, "/"); idx >= 0 {
		rawURL = rawURL[idx+1:]
	}
	// Remove leading slash if any and return
	return strings.TrimPrefix(rawURL, "/")
}

// Start starts the RTMP server
func (s *Server) Start() error {
	s.rtmpServer = &rtmp.Server{
		Addr: ":" + s.port,
	}

	// Handle publish events (ffmpeg pushes stream)
	s.rtmpServer.HandlePublish = func(conn *rtmp.Conn) {
		streamPath := extractStreamPath(conn.URL.String())
		log.Printf("[RTMP] New publish stream: %s (path=%s)", conn.URL.String(), streamPath)

		// Get or create the stream
		stream := s.streamMgr.GetOrCreateStream(streamPath)

		// Read codec info
		codecs, err := conn.Streams()
		if err != nil {
			log.Printf("[RTMP] Failed to get stream info: %v", err)
			return
		}

		// Update codec configuration
		if err := stream.UpdateCodecConfig(codecs); err != nil {
			log.Printf("[RTMP] Failed to update codec config: %v", err)
		}

		log.Printf("[RTMP] Stream codecs: %d streams", len(codecs))
		for _, codec := range codecs {
			if codec.Type().IsVideo() {
				if vc, ok := codec.(av.VideoCodecData); ok {
					log.Printf("[RTMP]   Video: %dx%d", vc.Width(), vc.Height())
				}
			} else if codec.Type().IsAudio() {
				log.Printf("[RTMP]   Audio codec")
			}
		}

		// Read and broadcast packets
		for {
			pkt, err := conn.ReadPacket()
			if err != nil {
				log.Printf("[RTMP] Stream ended: %v", err)
				break
			}

			// Broadcast video packets (audio packets are ignored for now)
			if pkt.Idx == 0 {
				stream.BroadcastVideoPacket(pkt)
			}
		}

		log.Printf("[RTMP] Publish stream closed: %s", streamPath)
		s.streamMgr.RemoveStream(streamPath)
	}

	// Handle play events (optional, for fallback RTMP playback)
	s.rtmpServer.HandlePlay = func(conn *rtmp.Conn) {
		log.Printf("[RTMP] New play request: %s (not supported via RTMP, use WebSocket)", conn.URL.String())
		conn.Close()
	}

	log.Printf("[RTMP] Starting RTMP server on :%s", s.port)

	go func() {
		if err := s.rtmpServer.ListenAndServe(); err != nil {
			log.Printf("[RTMP] Server error: %v", err)
		}
	}()

	// Give the server a moment to start
	time.Sleep(100 * time.Millisecond)
	return nil
}

// Stop stops the RTMP server (listener will be closed on process exit)
func (s *Server) Stop() {
	log.Println("[RTMP] Server stopping (listener closed on exit)")
}
