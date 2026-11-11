package websocket

import (
	"encoding/binary"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"carrot-streaming-media/internal/media"

	gorilla "github.com/gorilla/websocket"
)

func waitFor(t *testing.T, condition func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal(message)
		}
		time.Sleep(time.Millisecond)
	}
}

func assertSocketClosed(t *testing.T, conn *gorilla.Conn) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	_, _, err := conn.ReadMessage()
	if err == nil {
		t.Fatal("expected ended publication to close websocket")
	}
	if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatalf("websocket did not close promptly after publisher ended: %v", err)
	}
}

func TestPublisherEndImmediatelyClosesWaitingAndSubscribedSockets(t *testing.T) {
	for _, configured := range []bool{false, true} {
		name := "waiting-for-codec"
		if configured {
			name = "subscribed-and-receiving"
		}
		t.Run(name, func(t *testing.T) {
			manager := media.NewStreamManager()
			stream := manager.BeginPublish("live/car/audio")
			if configured {
				stream.SetAudioConfig(media.AudioCodecAAC, 44100, 1, []byte{0x12, 0x08})
			}
			server := NewServer("", manager, nil, "")
			entered, finished := make(chan struct{}), make(chan struct{})
			// Bind the exact generation before Dial. Dial's handshake completing does
			// not imply handleWebSocket has called GetOrCreateStream yet; removing a
			// path at that instant could otherwise create a new placeholder instead.
			httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					t.Errorf("upgrade: %v", err)
					return
				}
				server.connCount.Add(1)
				close(entered)
				defer close(finished)
				server.handleConnection(conn, "bound-test-player", stream, false, true)
			}))
			defer httpServer.Close()
			defer stream.Close()
			conn, _, err := gorilla.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("handler did not enter")
			}
			if configured {
				if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
					t.Fatal(err)
				}
				_, config, err := conn.ReadMessage()
				if err != nil || len(config) < 12 || binary.BigEndian.Uint32(config[:4]) != media.MsgTypeAudioConfig {
					t.Fatalf("expected audio codec config: %x, %v", config, err)
				}
				waitFor(t, func() bool { return stream.SubscriberCount() == 1 }, "player never subscribed")
				stream.BroadcastAudioData([]byte{1, 2, 3}, 23)
				_, frame, err := conn.ReadMessage()
				if err != nil || len(frame) < 12 || binary.BigEndian.Uint32(frame[:4]) != media.MsgTypeAudioFrame {
					t.Fatalf("expected audio frame: %x, %v", frame, err)
				}
			}
			manager.RemoveStream("live/car/audio", stream)
			assertSocketClosed(t, conn)
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("handler waited for old codec/inactivity timeout instead of publication end")
			}
			if server.ConnectionCount() != 0 {
				t.Fatal("ended connection still counted")
			}
		})
	}
}

func TestConnectionIDsStayUniqueAfterAnotherPlayerDisconnects(t *testing.T) {
	manager := media.NewStreamManager()
	stream := manager.BeginPublish("live/car/audio")
	stream.SetAudioConfig(media.AudioCodecAAC, 44100, 1, []byte{0x12, 0x08})
	defer stream.Close()
	server := NewServer("", manager, nil, "")
	httpServer := httptest.NewServer(http.HandlerFunc(server.handleWebSocket))
	defer httpServer.Close()
	dial := func() *gorilla.Conn {
		t.Helper()
		conn, _, err := gorilla.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+
			"/ws?audioUrl=live/car/audio", nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close() })
		conn.SetReadDeadline(time.Now().Add(time.Second))
		if _, _, err := conn.ReadMessage(); err != nil {
			t.Fatal(err)
		}
		return conn
	}
	first := dial()
	dial()
	waitFor(t, func() bool { return stream.SubscriberCount() == 2 }, "first two players not subscribed")
	stream.RemoveSubscriber("ws-1")
	assertSocketClosed(t, first)
	waitFor(t, func() bool { return server.ConnectionCount() == 1 }, "first player not removed")
	dial()
	waitFor(t, func() bool { return stream.SubscriberCount() == 2 }, "third player replaced the second player's ID")
	if server.ConnectionCount() != 2 {
		t.Fatal("active connection count does not match two remaining players")
	}
}
