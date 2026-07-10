package media

import (
	"encoding/binary"
	"sync"
	"time"

	"github.com/nareix/joy4/av"
	"github.com/nareix/joy4/codec/h264parser"
)

// Message types for WebTransport/WebSocket data
const (
	MsgTypeCodecConfig = 0
	MsgTypeVideoFrame  = 1
)

// Frame types
const (
	FrameTypeKeyFrame = 0
	FrameTypeDelta    = 1
)

// Subscriber represents a session that receives stream data
type Subscriber struct {
	VideoChan chan []byte
	Done      chan struct{}
}

// Stream represents a single stream identified by path (e.g. "live/stream")
type Stream struct {
	mu            sync.RWMutex
	subscribers   map[string]*Subscriber
	sps, pps      []byte
	width, height int
	hasConfig     bool
}

// NewStream creates a new Stream
func NewStream() *Stream {
	return &Stream{
		subscribers: make(map[string]*Subscriber),
	}
}

// UpdateCodecConfig extracts H264 codec configuration from stream codecs
func (s *Stream) UpdateCodecConfig(codecs []av.CodecData) error {
	for _, codec := range codecs {
		if codec.Type().IsVideo() {
			if vc, ok := codec.(av.VideoCodecData); ok {
				s.width = vc.Width()
				s.height = vc.Height()

				if cd, ok := vc.(h264parser.CodecData); ok {
					s.sps = make([]byte, len(cd.SPS()))
					copy(s.sps, cd.SPS())
					s.pps = make([]byte, len(cd.PPS()))
					copy(s.pps, cd.PPS())
					s.hasConfig = true
				}
			}
		}
	}
	return nil
}

// BuildCodecConfigMessage builds the codec configuration message
func (s *Stream) BuildCodecConfigMessage() []byte {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if !s.hasConfig {
		return nil
	}

	// Message format:
	// [4 bytes: message_type=0]
	// [4 bytes: timestamp=0]
	// [4 bytes: payload_length]
	// payload: [1 byte: codec=0(H264)]
	//          [4 bytes: sps_length][sps]
	//          [4 bytes: pps_length][pps]

	spsLen := len(s.sps)
	ppsLen := len(s.pps)
	payloadLen := 1 + 4 + spsLen + 4 + ppsLen
	msgLen := 4 + 4 + 4 + payloadLen

	msg := make([]byte, msgLen)
	binary.BigEndian.PutUint32(msg[0:4], MsgTypeCodecConfig)
	binary.BigEndian.PutUint32(msg[4:8], 0) // timestamp
	binary.BigEndian.PutUint32(msg[8:12], uint32(payloadLen))

	offset := 12
	msg[offset] = 0 // codec: H264
	offset++
	binary.BigEndian.PutUint32(msg[offset:offset+4], uint32(spsLen))
	offset += 4
	copy(msg[offset:offset+spsLen], s.sps)
	offset += spsLen
	binary.BigEndian.PutUint32(msg[offset:offset+4], uint32(ppsLen))
	offset += 4
	copy(msg[offset:offset+ppsLen], s.pps)

	return msg
}

// BroadcastVideoPacket broadcasts a video packet to all subscribers of this stream
func (s *Stream) BroadcastVideoPacket(pkt av.Packet) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if len(s.subscribers) == 0 {
		return
	}

	timestampMs := uint32(pkt.Time / time.Millisecond)

	frameType := FrameTypeDelta
	if pkt.IsKeyFrame {
		frameType = FrameTypeKeyFrame
	}

	// Send original AVCC format data (4-byte NALU length prefix)
	payloadLen := 1 + len(pkt.Data)
	msgLen := 4 + 4 + 4 + payloadLen
	msg := make([]byte, msgLen)

	binary.BigEndian.PutUint32(msg[0:4], MsgTypeVideoFrame)
	binary.BigEndian.PutUint32(msg[4:8], timestampMs)
	binary.BigEndian.PutUint32(msg[8:12], uint32(payloadLen))
	msg[12] = byte(frameType)
	copy(msg[13:], pkt.Data)

	for id, sub := range s.subscribers {
		select {
		case sub.VideoChan <- msg:
		case <-sub.Done:
			delete(s.subscribers, id)
		default:
			// Channel full, skip this frame for slow subscriber
		}
	}
}

// AddSubscriber adds a new subscriber
func (s *Stream) AddSubscriber(id string) *Subscriber {
	sub := &Subscriber{
		VideoChan: make(chan []byte, 120),
		Done:      make(chan struct{}),
	}

	s.mu.Lock()
	s.subscribers[id] = sub
	s.mu.Unlock()

	return sub
}

// RemoveSubscriber removes a subscriber
func (s *Stream) RemoveSubscriber(id string) {
	s.mu.Lock()
	if sub, ok := s.subscribers[id]; ok {
		close(sub.Done)
		delete(s.subscribers, id)
	}
	s.mu.Unlock()
}

// HasConfig returns whether codec config is available
func (s *Stream) HasConfig() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.hasConfig
}

// GetStreamInfo returns stream information
func (s *Stream) GetStreamInfo() (width, height int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.width, s.height
}

// SubscriberCount returns the number of active subscribers
func (s *Stream) SubscriberCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.subscribers)
}

// ---------------------------------------------------------------------------
// StreamManager manages multiple streams by path
// ---------------------------------------------------------------------------

// StreamManager manages multiple streams keyed by path
type StreamManager struct {
	mu      sync.RWMutex
	streams map[string]*Stream
}

// NewStreamManager creates a new stream manager
func NewStreamManager() *StreamManager {
	return &StreamManager{
		streams: make(map[string]*Stream),
	}
}

// GetOrCreateStream returns the stream for the given path, creating it if needed
func (sm *StreamManager) GetOrCreateStream(path string) *Stream {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	s, ok := sm.streams[path]
	if !ok {
		s = NewStream()
		sm.streams[path] = s
	}
	return s
}

// GetStream returns the stream for the given path, or nil if it doesn't exist
func (sm *StreamManager) GetStream(path string) *Stream {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.streams[path]
}

// RemoveStream removes a stream by path
func (sm *StreamManager) RemoveStream(path string) {
	sm.mu.Lock()
	delete(sm.streams, path)
	sm.mu.Unlock()
}

// StreamCount returns the number of active streams
func (sm *StreamManager) StreamCount() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return len(sm.streams)
}
