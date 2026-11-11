//go:build !linux

package websocket

// Unsupported clock status must not be advertised as synchronized.
func kernelClockState() (bool, int64) { return false, 0 }
