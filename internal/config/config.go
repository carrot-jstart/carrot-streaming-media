package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config holds all server configuration.
type Config struct {
	// SSL certificate files (relative to project root)
	SSLCert string
	SSLKey  string

	// Server ports
	HTTPPort   int
	RTMPPort   int
	WsPushPort int

	// Web static files directory
	WebDir string

	// Log level: debug, info, warn, error
	LogLevel string
}

// Load reads and parses the config file at the given path.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file %s: %w", path, err)
	}

	cfg := &Config{
		// defaults
		SSLCert:    "./cert/localhost+3.pem",
		SSLKey:     "./cert/localhost+3-key.pem",
		HTTPPort:   8080,
		RTMPPort:   1935,
		WsPushPort: 7778,
		WebDir:     "./web",
		LogLevel:   "info",
	}

	lines := strings.Split(string(data), "\n")
	for i, line := range lines {
		line = strings.TrimSpace(line)

		// skip empty lines and comments
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		// parse key=value
		eqIdx := strings.IndexByte(line, '=')
		if eqIdx < 0 {
			continue
		}

		key := strings.TrimSpace(line[:eqIdx])
		val := strings.TrimSpace(line[eqIdx+1:])
		val = strings.Trim(val, `"`)

		if err := cfg.setField(key, val, i+1); err != nil {
			return nil, err
		}
	}

	return cfg, nil
}

func (cfg *Config) setField(key, val string, lineNum int) error {
	switch strings.ToLower(key) {
	case "ssl_certificate":
		cfg.SSLCert = val
	case "ssl_certificate_key":
		cfg.SSLKey = val
	case "http_port":
		port, err := strconv.Atoi(val)
		if err != nil {
			return fmt.Errorf("line %d: invalid http_port '%s'", lineNum, val)
		}
		cfg.HTTPPort = port
	case "rtmp_port":
		port, err := strconv.Atoi(val)
		if err != nil {
			return fmt.Errorf("line %d: invalid rtmp_port '%s'", lineNum, val)
		}
		cfg.RTMPPort = port
	case "ws_push_port":
		port, err := strconv.Atoi(val)
		if err != nil {
			return fmt.Errorf("line %d: invalid push_port '%s'", lineNum, val)
		}
		cfg.WsPushPort = port
	case "web_dir":
		cfg.WebDir = val
	case "log_level":
		val = strings.ToLower(val)
		switch val {
		case "debug", "info", "warn", "error":
			cfg.LogLevel = val
		default:
			return fmt.Errorf("line %d: invalid log_level '%s' (expected: debug, info, warn, error)", lineNum, val)
		}
	default:
		return fmt.Errorf("line %d: unknown config key '%s'", lineNum, key)
	}
	return nil
}

func (cfg *Config) String() string {
	return fmt.Sprintf(
		"HTTP:%d RTMP:%d Push:%d cert:%s web:%s log:%s",
		cfg.HTTPPort, cfg.RTMPPort, cfg.WsPushPort, cfg.SSLCert, cfg.WebDir, cfg.LogLevel,
	)
}
