package cert

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"log"
	"os"
)

// LoadTLSConfig loads TLS certificate from the given PEM files.
// certFile: path to the certificate PEM (may include CA chain)
// keyFile:  path to the private key PEM
func LoadTLSConfig(certFile, keyFile string) (*tls.Config, error) {
	// Read certificate PEM file
	certPEM, err := os.ReadFile(certFile)
	if err != nil {
		return nil, fmt.Errorf("failed to read certificate %s: %w", certFile, err)
	}

	// Read private key PEM file
	keyPEM, err := os.ReadFile(keyFile)
	if err != nil {
		return nil, fmt.Errorf("failed to read private key %s: %w", keyFile, err)
	}

	// Parse all certificates from PEM (leaf first, then CA intermediates)
	var certDERs [][]byte
	rest := certPEM
	for {
		block, remaining := pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type == "CERTIFICATE" {
			certDERs = append(certDERs, block.Bytes)
		}
		rest = remaining
	}

	if len(certDERs) == 0 {
		return nil, fmt.Errorf("no certificate found in %s", certFile)
	}

	// Parse private key
	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return nil, fmt.Errorf("no private key found in %s", keyFile)
	}

	var privateKey any
	privateKey, err = x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if err != nil {
		privateKey, err = x509.ParsePKCS1PrivateKey(keyBlock.Bytes)
		if err != nil {
			return nil, fmt.Errorf("failed to parse private key from %s: %w", keyFile, err)
		}
	}

	cert := tls.Certificate{
		Certificate: certDERs,
		PrivateKey:  privateKey,
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"h3", "h2", "http/1.1"},
	}

	log.Printf("[Cert] Loaded: %s (%d certificates)", certFile, len(certDERs))
	return tlsConfig, nil
}
