package websocket

import (
	"carrot-streaming-media/internal/media"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestTimeRouteIsFreshAndReportsClockQuality(t *testing.T) {
	server := NewServer("", media.NewStreamManager(), nil, t.TempDir())
	calls := int64(0)
	server.timeSource = func() serverClock {
		calls++
		return serverClock{UnixMS: 1700000000000 + calls, Synchronized: true, MaxErrorMS: 7}
	}
	for i := int64(1); i <= 2; i++ {
		response := httptest.NewRecorder()
		server.handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/time", nil))
		if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" ||
			response.Header().Get("Access-Control-Allow-Origin") != "*" {
			t.Fatal("time route unavailable or cacheable")
		}
		var data serverClock
		if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		if data.UnixMS != 1700000000000+i || !data.Synchronized || data.MaxErrorMS != 7 {
			t.Fatalf("bad time report: %+v", data)
		}
	}
	response := httptest.NewRecorder()
	server.handler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/time", nil))
	if response.Code != 405 || calls != 2 {
		t.Fatal("non-GET request was served")
	}
}

func TestTimeRouteUsesCurrentClockWithoutClaimingUnknownStatus(t *testing.T) {
	server := NewServer("", media.NewStreamManager(), nil, t.TempDir())
	before := time.Now().UnixMilli()
	response := httptest.NewRecorder()
	server.handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/time", nil))
	var data serverClock
	if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if data.UnixMS < before || data.UnixMS > time.Now().UnixMilli() {
		t.Fatal("time route returned stale time")
	}
	if data.MaxErrorMS < 0 || data.MaxErrorMS > 1000 {
		t.Fatal("clock uncertainty out of contract")
	}
}
