package media

import (
	"encoding/binary"
	"encoding/hex"
	"github.com/nareix/joy4/av"
	"testing"
	"time"
)

// Timestamp SEI is an ordinary H.264 NAL. No WSS header/protocol change is required.
func TestVideoTimestampSEIIsForwardedUnmodified(t *testing.T) {
	data, err := hex.DecodeString("0000002406051eb7e54ad89a314df7b8dd87ac6e29cc710101000003018bcfe5687b00000300118000000003658884")
	if err != nil {
		t.Fatal(err)
	}
	stream := NewStream()
	sub := stream.AddSubscriber("latency-wire", true, false)
	stream.BroadcastVideoPacket(av.Packet{Data: data, Time: 42 * time.Millisecond, IsKeyFrame: true})
	select {
	case message := <-sub.FrameChan:
		if binary.BigEndian.Uint32(message[:4]) != MsgTypeVideoFrame ||
			binary.BigEndian.Uint32(message[4:8]) != 42 ||
			int(binary.BigEndian.Uint32(message[8:12])) != len(data)+1 || message[12] != FrameTypeKeyFrame {
			t.Fatal("WSS frame header changed")
		}
		if string(message[13:]) != string(data) {
			t.Fatal("capture timestamp SEI or video bytes were modified")
		}
	case <-time.After(time.Second):
		t.Fatal("timestamped frame not forwarded")
	}
	stream.Close()
}
