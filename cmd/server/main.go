package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"carrot-streaming-media/cert"
	"carrot-streaming-media/internal/config"
	"carrot-streaming-media/internal/media"
	"carrot-streaming-media/internal/rtmp"
	ws "carrot-streaming-media/internal/websocket"
)

func main() {
	configPath := flag.String("config", "carrot.conf", "config file path")
	flag.Parse()

	// Load configuration
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
	log.Println("=== Carrot Streaming Media Server ===")
	log.Printf("Config: %s", cfg)

	// Load TLS certificate from config-specified paths
	tlsConfig, err := cert.LoadTLSConfig(cfg.SSLCert, cfg.SSLKey)
	if err != nil {
		log.Fatalf("Failed to load TLS config: %v", err)
	}

	// Create stream manager
	streamMgr := media.NewStreamManager()

	// Parse ports
	rtmpPortStr := strconv.Itoa(cfg.RTMPPort)
	httpPortStr := strconv.Itoa(cfg.HTTPPort)

	// Create and start RTMP server
	rtmpServer := rtmp.NewServer(rtmpPortStr, streamMgr)
	if err := rtmpServer.Start(); err != nil {
		log.Fatalf("Failed to start RTMP server: %v", err)
	}
	log.Printf("RTMP server listening on :%d", cfg.RTMPPort)

	// Create and start WebSocket server (HTTPS/WSS)
	wsServer := ws.NewServer(httpPortStr, streamMgr, tlsConfig, cfg.WebDir)
	if err := wsServer.Start(); err != nil {
		log.Fatalf("Failed to start WebSocket server: %v", err)
	}
	log.Printf("WebSocket server listening on :%d (HTTPS/WSS)", cfg.HTTPPort)

	// Create and start WebSocket push server (for browser audio/video push)
	pushServer := ws.NewPushServer(strconv.Itoa(cfg.WsPushPort), streamMgr, tlsConfig, cfg.WebDir)
	if err := pushServer.Start(); err != nil {
		log.Fatalf("Failed to start push server: %v", err)
	}
	log.Printf("Push server listening on :%d (WS)", cfg.WsPushPort)

	// Print usage instructions
	printUsage(cfg)

	// Wait for shutdown signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("Shutting down...")
	rtmpServer.Stop()
	wsServer.Stop()
	pushServer.Stop()
	log.Println("Server stopped")
}

func printUsage(cfg *config.Config) {
	fmt.Println()
	fmt.Println("========================================")
	fmt.Println("  Streaming Media Server is Running!")
	fmt.Println("========================================")
	fmt.Println()
	fmt.Println("  Push Video Stream:")
	fmt.Println("    ffmpeg -re -i <input> -c:v libx264 -preset ultrafast -tune zerolatency -g 30")
	fmt.Println("           -c:a aac -ar 44100 -ac 2 -f flv")
	fmt.Println("           rtmp://localhost:" + strconv.Itoa(cfg.RTMPPort) + "/live/stream")
	fmt.Println()
	fmt.Println("  Push Audio-only Stream (low latency):")
	fmt.Println("    ffmpeg -fflags nobuffer -flags low_delay -f dshow -i audio=\"Microphone\"")
	fmt.Println("           -c:a aac -b:a 128k -ar 44100 -ac 2 -f flv")
	fmt.Println("           rtmp://localhost:" + strconv.Itoa(cfg.RTMPPort) + "/audio/stream")
	fmt.Println()
	fmt.Println("  Playback (combined):")
	fmt.Println("    https://localhost:" + strconv.Itoa(cfg.HTTPPort) + "/?videoUrl=live/stream&audioUrl=audio/stream")
	fmt.Println()
	fmt.Println("  Playback (video only):")
	fmt.Println("    https://localhost:" + strconv.Itoa(cfg.HTTPPort) + "/?videoUrl=live/stream")
	fmt.Println()
	fmt.Println("  Playback (audio only):")
	fmt.Println("    https://localhost:" + strconv.Itoa(cfg.HTTPPort) + "/?audioUrl=audio/stream")
	fmt.Println()
	fmt.Println("  Browser Media Push (WebSocket):")
	fmt.Println("    http://localhost:" + strconv.Itoa(cfg.WsPushPort) + "/push.html")
	fmt.Println()
	fmt.Println("========================================")
	fmt.Println()
}
