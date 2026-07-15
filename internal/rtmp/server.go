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

		// Update video codec configuration
		if err := stream.UpdateCodecConfig(codecs); err != nil {
			log.Printf("[RTMP] Failed to update video codec config: %v", err)
		}

		// Update audio codec configuration
		if err := stream.UpdateAudioCodecConfig(codecs); err != nil {
			log.Printf("[RTMP] Failed to update audio codec config: %v", err)
		}

		// Build index maps for routing packets by stream index
		// pkt.Idx corresponds to the index in the codecs slice
		isVideoIdx := make(map[int8]bool)
		isAudioIdx := make(map[int8]bool)
		for i, c := range codecs {
			if c.Type().IsVideo() {
				isVideoIdx[int8(i)] = true
				if vc, ok := c.(av.VideoCodecData); ok {
					log.Printf("[RTMP]   Video stream[%d]: %dx%d", i, vc.Width(), vc.Height())
				}
			} else if c.Type().IsAudio() {
				isAudioIdx[int8(i)] = true
				if ac, ok := c.(av.AudioCodecData); ok {
					log.Printf("[RTMP]   Audio stream[%d]: %d Hz, %d channels", i, ac.SampleRate(), ac.ChannelLayout().Count())
				}
			}
		}

		log.Printf("[RTMP] Stream codecs: %d streams (%d video, %d audio)",
			len(codecs), len(isVideoIdx), len(isAudioIdx))

		// Read and broadcast packets
		for {
			pkt, err := conn.ReadPacket()
			if err != nil {
				log.Printf("[RTMP] Stream ended: %v", err)
				break
			}

			if isVideoIdx[pkt.Idx] {
				stream.BroadcastVideoPacket(pkt)
			} else if isAudioIdx[pkt.Idx] {
				stream.BroadcastAudioPacket(pkt)
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
