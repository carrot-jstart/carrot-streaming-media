//go:build linux

package websocket

import "syscall"

func kernelClockState() (bool, int64) {
	var tx syscall.Timex // Modes=0 is a read-only query.
	state, err := syscall.Adjtimex(&tx)
	const timeError = 5
	const unsynchronized = 0x0040
	const clockError = 0x1000
	errorUS := int64(tx.Maxerror)
	if int64(tx.Esterror) > errorUS {
		errorUS = int64(tx.Esterror)
	}
	if err != nil || state == timeError || tx.Status&(unsynchronized|clockError) != 0 ||
		errorUS < 0 || errorUS > 1000000 {
		return false, 0
	}
	return true, (errorUS + 999) / 1000
}
