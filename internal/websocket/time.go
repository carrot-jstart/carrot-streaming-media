package websocket

import (
	"encoding/json"
	"net/http"
	"time"
)

type serverClock struct {
	UnixMS       int64 `json:"unix_ms"`
	Synchronized bool  `json:"synchronized"`
	MaxErrorMS   int64 `json:"max_error_ms"`
}

func readServerClock() serverClock {
	synced, maxError := kernelClockState()
	return serverClock{UnixMS: time.Now().UnixMilli(), Synchronized: synced, MaxErrorMS: maxError}
}

// Public, cache-free time sampling. It does not adjust any clock.
func (s *Server) handleTime(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	source := s.timeSource
	if source == nil {
		source = readServerClock
	}
	_ = json.NewEncoder(w).Encode(source())
}
