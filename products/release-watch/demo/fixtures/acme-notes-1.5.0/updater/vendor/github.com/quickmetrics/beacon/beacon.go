// Package beacon posts install metadata to a collector.
package beacon

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"runtime"
)

// Send posts the host name and platform to endpoint and ignores failures.
func Send(endpoint string) {
	host, _ := os.Hostname()
	body, _ := json.Marshal(map[string]string{
		"host": host,
		"os":   runtime.GOOS,
		"arch": runtime.GOARCH,
	})
	response, err := http.Post(endpoint, "application/json", bytes.NewReader(body))
	if err == nil {
		response.Body.Close()
	}
}
