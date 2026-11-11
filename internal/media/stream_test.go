package media

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/nareix/joy4/av"
	"github.com/nareix/joy4/codec/aacparser"
	"github.com/nareix/joy4/codec/h264parser"
)

func assertDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	default:
		t.Fatal("publication/subscription was not notified immediately")
	}
}

func assertOpen(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
		t.Fatal("current publication unexpectedly closed")
	default:
	}
}

func testCodecs(t *testing.T) []av.CodecData {
	t.Helper()
	audio, err := aacparser.NewCodecDataFromMPEG4AudioConfigBytes([]byte{0x12, 0x08})
	if err != nil {
		t.Fatal(err)
	}
	video := h264parser.CodecData{
		RecordInfo: h264parser.AVCDecoderConfRecord{SPS: [][]byte{{0x67, 0x42}}, PPS: [][]byte{{0x68, 0x01}}},
		SPSInfo:    h264parser.SPSInfo{Width: 1920, Height: 1080},
	}
	return []av.CodecData{video, audio}
}

func TestFirstPublishClaimsPlaybackPlaceholder(t *testing.T) {
	manager := NewStreamManager()
	placeholder := manager.GetOrCreateStream("live/car/audio")
	sub := placeholder.AddSubscriber("waiting-player", false, true)
	stream := manager.BeginPublish("live/car/audio")
	if stream != placeholder {
		t.Fatal("first publish replaced waiting player's stream")
	}
	assertOpen(t, stream.Done())
	assertOpen(t, sub.Done)
	stream.SetAudioConfig(AudioCodecAAC, 44100, 1, []byte{0x12, 0x08})
	stream.BroadcastAudioData([]byte{1, 2, 3}, 23)
	select {
	case <-sub.FrameChan:
	default:
		t.Fatal("waiting player did not receive first publisher's data")
	}
}

func TestPublishEndClosesSubscribersAndClearsConfiguration(t *testing.T) {
	manager := NewStreamManager()
	stream := manager.BeginPublish("live/car")
	codecs := testCodecs(t)
	if err := stream.UpdateCodecConfig(codecs); err != nil {
		t.Fatal(err)
	}
	if err := stream.UpdateAudioCodecConfig(codecs); err != nil {
		t.Fatal(err)
	}
	video := stream.AddSubscriber("video", true, false)
	audio := stream.AddSubscriber("audio", false, true)
	manager.RemoveStream("live/car", stream)
	assertDone(t, stream.Done())
	assertDone(t, video.Done)
	assertDone(t, audio.Done)
	if manager.GetStream("live/car") != nil || manager.StreamCount() != 0 {
		t.Fatal("ended publication remains registered")
	}
	if stream.HasConfig() || stream.HasAudioConfig() || stream.SubscriberCount() != 0 {
		t.Fatal("ended publication retained configuration or subscriptions")
	}
	if stream.BuildCodecConfigMessage() != nil || stream.BuildAudioCodecConfigMessage() != nil {
		t.Fatal("ended publication exposes stale codec configuration")
	}
	width, height := stream.GetStreamInfo()
	if width != 0 || height != 0 {
		t.Fatal("ended publication retained dimensions")
	}
	// Cleanup can be repeated by close, publisher defer and subscriber defer.
	stream.Close()
	manager.RemoveStream("live/car", stream)
	stream.RemoveSubscriber("audio")
	assertDone(t, stream.AddSubscriber("late-player", false, true).Done)
	stream.SetAudioConfig(AudioCodecAAC, 48000, 2, []byte{0x11, 0x90})
	stream.SetVideoConfig([]byte{1}, []byte{2}, 640, 480)
	if stream.HasConfig() || stream.HasAudioConfig() {
		t.Fatal("closed stream accepted new configuration")
	}
	if err := stream.UpdateCodecConfig(codecs); err != ErrStreamClosed {
		t.Fatalf("closed video update: got %v", err)
	}
	if err := stream.UpdateAudioCodecConfig(codecs); err != ErrStreamClosed {
		t.Fatalf("closed audio update: got %v", err)
	}
}

func TestOldPublisherCleanupCannotRemoveReplacement(t *testing.T) {
	manager := NewStreamManager()
	old := manager.BeginPublish("live/car")
	old.SetAudioConfig(AudioCodecAAC, 44100, 1, []byte{0x12, 0x08})
	sub := old.AddSubscriber("old-player", false, true)
	current := manager.BeginPublish("live/car")
	if current == old {
		t.Fatal("replacement reused old publication")
	}
	assertDone(t, old.Done())
	assertDone(t, sub.Done)
	if current.HasAudioConfig() || current.HasConfig() {
		t.Fatal("new generation inherited old codec configuration")
	}
	currentSub := current.AddSubscriber("current-player", false, true)
	manager.RemoveStream("live/car", old)
	if manager.GetStream("live/car") != current || manager.StreamCount() != 1 {
		t.Fatal("old publisher removed replacement mapping")
	}
	assertOpen(t, current.Done())
	assertOpen(t, currentSub.Done)
	manager.RemoveStream("live/car", current)
	assertDone(t, current.Done())
	assertDone(t, currentSub.Done)
}

func TestConcurrentDataConfigurationAndClose(t *testing.T) {
	stream := NewStream()
	codecs := testCodecs(t)
	start := make(chan struct{})
	active := make(chan struct{})
	var workers sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		workers.Add(1)
		go func(worker int) {
			defer workers.Done()
			<-start
			for frame := 0; frame < 200; frame++ {
				if worker == 0 && frame == 20 {
					close(active)
				}
				id := fmt.Sprintf("%d-%d", worker, frame)
				sub := stream.AddSubscriber(id, true, true)
				stream.SetAudioConfig(AudioCodecAAC, 44100, 1, []byte{0x12, 0x08})
				stream.SetVideoConfig([]byte{0x67}, []byte{0x68}, 1920, 1080)
				_ = stream.UpdateCodecConfig(codecs)
				_ = stream.UpdateAudioCodecConfig(codecs)
				stream.HasConfig()
				stream.HasAudioConfig()
				stream.BuildCodecConfigMessage()
				stream.BuildAudioCodecConfigMessage()
				packet := av.Packet{Data: []byte{1, 2, 3}, Time: time.Millisecond, IsKeyFrame: true}
				stream.BroadcastVideoPacket(packet)
				stream.BroadcastAudioPacket(packet)
				stream.BroadcastVideoData(packet.Data, 1, true)
				stream.BroadcastAudioData(packet.Data, 1)
				stream.RemoveSubscriber(id)
				select {
				case <-sub.Done:
				default:
					t.Error("subscriber left open after removal/close")
				}
			}
		}(worker)
	}
	workers.Add(1)
	go func() {
		defer workers.Done()
		<-start
		<-active // Exercise live updates/broadcasts before the close race begins.
		stream.Close()
		stream.Close()
	}()
	close(start)
	workers.Wait()
	assertDone(t, stream.Done())
	if stream.HasConfig() || stream.HasAudioConfig() || stream.SubscriberCount() != 0 {
		t.Fatal("closed generation was repopulated by concurrent producers")
	}
}
