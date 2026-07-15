package media

import (
	"encoding/binary"
	"sync"
	"time"

	"github.com/nareix/joy4/av"
	"github.com/nareix/joy4/codec/aacparser"
	"github.com/nareix/joy4/codec/h264parser"
)

// Message types for WebSocket data
const (
	MsgTypeCodecConfig = 0
	MsgTypeVideoFrame  = 1
	MsgTypeAudioConfig = 2
	MsgTypeAudioFrame  = 3
)

// Audio codec types (used in audio config message)
const (
	AudioCodecAAC = 0
	AudioCodecMP3 = 1
)

// Frame types
const (
	FrameTypeKeyFrame = 0
	FrameTypeDelta    = 1
)

// Subscriber represents a session that receives stream data
type Subscriber struct {
	FrameChan  chan []byte
	Done       chan struct{}
	WantsVideo bool
	WantsAudio bool
}

// Stream represents a single stream identified by path (e.g. "live/stream")
type Stream struct {
	mu          sync.RWMutex
	subscribers map[string]*Subscriber
	// Video
	sps, pps      []byte
	width, height int
	hasConfig     bool
	// Audio
	audioCodecType  byte // AudioCodecAAC or AudioCodecMP3
	sampleRate      int
	channels        int
	audioConfigData []byte // AudioSpecificConfig for AAC (codec-specific config)
	hasAudioConfig  bool
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

// UpdateAudioCodecConfig extracts audio codec configuration from stream codecs
func (s *Stream) UpdateAudioCodecConfig(codecs []av.CodecData) error {
	for _, codec := range codecs {
		if codec.Type().IsAudio() {
			if ac, ok := codec.(av.AudioCodecData); ok {
				s.sampleRate = ac.SampleRate()
				s.channels = ac.ChannelLayout().Count()

				switch {
				case ac.Type() == av.AAC:
					s.audioCodecType = AudioCodecAAC
					if aacCD, ok := ac.(aacparser.CodecData); ok {
						configBytes := aacCD.MPEG4AudioConfigBytes()
						s.audioConfigData = make([]byte, len(configBytes))
						copy(s.audioConfigData, configBytes)
					}
				default:
					s.audioCodecType = AudioCodecMP3
				}

				s.hasAudioConfig = true
			}
		}
	}
	return nil
}

// BuildCodecConfigMessage builds the video codec configuration message
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

// BuildAudioCodecConfigMessage builds the audio codec configuration message
func (s *Stream) BuildAudioCodecConfigMessage() []byte {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if !s.hasAudioConfig {
		return nil
	}

	// Message format:
	// [4 bytes: message_type=2]
	// [4 bytes: timestamp=0]
	// [4 bytes: payload_length]
	// payload: [1 byte: codec_type] (0=AAC, 1=MP3)
	//          [4 bytes: sample_rate] (int32 big-endian)
	//          [1 byte: channels]
	//          [variable: codec-specific config data]
	//            For AAC: AudioSpecificConfig bytes
	//            For MP3: empty

	configDataLen := len(s.audioConfigData)
	payloadLen := 1 + 4 + 1 + configDataLen
	msgLen := 4 + 4 + 4 + payloadLen

	msg := make([]byte, msgLen)
	binary.BigEndian.PutUint32(msg[0:4], MsgTypeAudioConfig)
	binary.BigEndian.PutUint32(msg[4:8], 0) // timestamp
	binary.BigEndian.PutUint32(msg[8:12], uint32(payloadLen))

	offset := 12
	msg[offset] = s.audioCodecType
	offset++
	binary.BigEndian.PutUint32(msg[offset:offset+4], uint32(s.sampleRate))
	offset += 4
	msg[offset] = byte(s.channels)
	offset++
	if configDataLen > 0 {
		copy(msg[offset:offset+configDataLen], s.audioConfigData)
	}

	return msg
}

// BroadcastVideoPacket broadcasts a video packet to subscribers that want video
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

	s.broadcastVideoToSubscribers(msg)
}

// BroadcastAudioPacket broadcasts an audio packet to subscribers that want audio
func (s *Stream) BroadcastAudioPacket(pkt av.Packet) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if len(s.subscribers) == 0 {
		return
	}

	timestampMs := uint32(pkt.Time / time.Millisecond)

	// Message format:
	// [4 bytes: message_type=3]
	// [4 bytes: timestamp_ms]
	// [4 bytes: payload_length]
	// payload: [raw audio frame data]
	//   For AAC: raw AAC frame (no ADTS header)
	//   For MP3: raw MP3 frame

	payloadLen := len(pkt.Data)
	msgLen := 4 + 4 + 4 + payloadLen
	msg := make([]byte, msgLen)

	binary.BigEndian.PutUint32(msg[0:4], MsgTypeAudioFrame)
	binary.BigEndian.PutUint32(msg[4:8], timestampMs)
	binary.BigEndian.PutUint32(msg[8:12], uint32(payloadLen))
	copy(msg[12:], pkt.Data)

	s.broadcastAudioToSubscribers(msg)
}

// BroadcastAudioData broadcasts raw audio frame data to subscribers that want audio.
// Unlike BroadcastAudioPacket, this accepts raw bytes directly (for browser-pushed audio).
func (s *Stream) BroadcastAudioData(data []byte, timestampMs uint32) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if len(s.subscribers) == 0 {
		return
	}

	payloadLen := len(data)
	msgLen := 4 + 4 + 4 + payloadLen
	msg := make([]byte, msgLen)

	binary.BigEndian.PutUint32(msg[0:4], MsgTypeAudioFrame)
	binary.BigEndian.PutUint32(msg[4:8], timestampMs)
	binary.BigEndian.PutUint32(msg[8:12], uint32(payloadLen))
	copy(msg[12:], data)

	s.broadcastAudioToSubscribers(msg)
}

// SetAudioConfig sets audio codec config from known parameters (for browser pushes).
func (s *Stream) SetAudioConfig(codecType byte, sampleRate int, channels int, configData []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.audioCodecType = codecType
	s.sampleRate = sampleRate
	s.channels = channels
	s.audioConfigData = make([]byte, len(configData))
	copy(s.audioConfigData, configData)
	s.hasAudioConfig = true
}

// SetVideoConfig sets video codec config from known parameters (for browser pushes).
func (s *Stream) SetVideoConfig(sps, pps []byte, width, height int) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.sps = make([]byte, len(sps))
	copy(s.sps, sps)
	s.pps = make([]byte, len(pps))
	copy(s.pps, pps)
	s.width = width
	s.height = height
	s.hasConfig = true
}

// BroadcastVideoData broadcasts raw H.264 video frame data to subscribers that want video.
// Unlike BroadcastVideoPacket, this accepts raw bytes directly (for browser-pushed video).
func (s *Stream) BroadcastVideoData(data []byte, timestampMs uint32, isKeyFrame bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if len(s.subscribers) == 0 {
		return
	}

	frameType := FrameTypeDelta
	if isKeyFrame {
		frameType = FrameTypeKeyFrame
	}

	payloadLen := 1 + len(data)
	msgLen := 4 + 4 + 4 + payloadLen
	msg := make([]byte, msgLen)

	binary.BigEndian.PutUint32(msg[0:4], MsgTypeVideoFrame)
	binary.BigEndian.PutUint32(msg[4:8], timestampMs)
	binary.BigEndian.PutUint32(msg[8:12], uint32(payloadLen))
	msg[12] = byte(frameType)
	copy(msg[13:], data)

	s.broadcastVideoToSubscribers(msg)
}

// broadcastVideoToSubscribers sends a message only to subscribers that want video
func (s *Stream) broadcastVideoToSubscribers(msg []byte) {
	for id, sub := range s.subscribers {
		if !sub.WantsVideo {
			continue
		}
		select {
		case sub.FrameChan <- msg:
		case <-sub.Done:
			delete(s.subscribers, id)
		default:
			// Channel full, skip this frame for slow subscriber
		}
	}
}

// broadcastAudioToSubscribers sends a message only to subscribers that want audio
func (s *Stream) broadcastAudioToSubscribers(msg []byte) {
	for id, sub := range s.subscribers {
		if !sub.WantsAudio {
			continue
		}
		select {
		case sub.FrameChan <- msg:
		case <-sub.Done:
			delete(s.subscribers, id)
		default:
			// Channel full, skip this frame for slow subscriber
		}
	}
}

// AddSubscriber adds a new subscriber with specified media type preferences
func (s *Stream) AddSubscriber(id string, wantsVideo, wantsAudio bool) *Subscriber {
	sub := &Subscriber{
		FrameChan:  make(chan []byte, 120),
		Done:       make(chan struct{}),
		WantsVideo: wantsVideo,
		WantsAudio: wantsAudio,
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

// HasConfig returns whether video codec config is available
func (s *Stream) HasConfig() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.hasConfig
}

// HasAudioConfig returns whether audio codec config is available
func (s *Stream) HasAudioConfig() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.hasAudioConfig
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
