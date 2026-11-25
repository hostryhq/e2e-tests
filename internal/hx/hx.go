// Package hx holds the small helpers the end-to-end tests share: a JSON HTTP client, TOTP, and the device-key
// signatures the identity service expects.
package hx

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Resp is one HTTP answer.
type Resp struct {
	Status  int
	Body    []byte
	Header  http.Header
	Elapsed time.Duration
}

// JSON decodes the body into v.
func (r Resp) JSON(v any) error { return json.Unmarshal(r.Body, v) }

// Map decodes the body into a generic map (nil on failure).
func (r Resp) Map() map[string]any {
	var m map[string]any
	_ = json.Unmarshal(r.Body, &m)
	return m
}

func (r Resp) String() string {
	return fmt.Sprintf("%d %s", r.Status, strings.TrimSpace(string(r.Body)))
}

// Client is a JSON client for one base URL.
type Client struct {
	Base   string
	HTTP   *http.Client
	Header http.Header // sent on every request (Authorization, Cookie, Origin ...)
}

// New returns a client with sane timeouts and a connection pool sized for load runs.
func New(base string) *Client {
	tr := &http.Transport{MaxIdleConns: 512, MaxIdleConnsPerHost: 512, IdleConnTimeout: 30 * time.Second}
	return &Client{Base: base, HTTP: &http.Client{Timeout: 30 * time.Second, Transport: tr}, Header: http.Header{}}
}

// With returns a copy of the client with extra default headers.
func (c *Client) With(kv ...string) *Client {
	n := &Client{Base: c.Base, HTTP: c.HTTP, Header: c.Header.Clone()}
	for i := 0; i+1 < len(kv); i += 2 {
		n.Header.Set(kv[i], kv[i+1])
	}
	return n
}

// Do sends a request; body (if non-nil) is marshalled as JSON. extra are header key/value pairs.
func (c *Client) Do(method, path string, body any, extra ...string) Resp {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.Base+path, rd)
	if err != nil {
		return Resp{Status: -1, Body: []byte(err.Error())}
	}
	for k, vs := range c.Header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(extra); i += 2 {
		req.Header.Set(extra[i], extra[i+1])
	}
	t0 := time.Now()
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return Resp{Status: -1, Body: []byte(err.Error()), Elapsed: time.Since(t0)}
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return Resp{Status: resp.StatusCode, Body: b, Header: resp.Header, Elapsed: time.Since(t0)}
}

// Get, Post, Put, Delete are shorthands; extra are header pairs.
func (c *Client) Get(path string, extra ...string) Resp { return c.Do("GET", path, nil, extra...) }
func (c *Client) Post(path string, body any, extra ...string) Resp {
	return c.Do("POST", path, body, extra...)
}
func (c *Client) Put(path string, body any, extra ...string) Resp {
	return c.Do("PUT", path, body, extra...)
}
func (c *Client) Delete(path string, extra ...string) Resp {
	return c.Do("DELETE", path, nil, extra...)
}

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----

// TOTPFromURI extracts the secret of an otpauth:// URI.
func TOTPFromURI(uri string) (string, error) {
	i := strings.Index(uri, "secret=")
	if i < 0 {
		return "", fmt.Errorf("no secret in %q", uri)
	}
	s := uri[i+len("secret="):]
	if j := strings.IndexAny(s, "&"); j >= 0 {
		s = s[:j]
	}
	return s, nil
}

// TOTPAt returns the code of a base32 secret for a time step.
func TOTPAt(secret string, step int64) (string, error) {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimRight(secret, "=")))
	if err != nil {
		return "", err
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step))
	m := hmac.New(sha1.New, key)
	m.Write(msg[:])
	sum := m.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	code := (binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff) % 1000000
	return fmt.Sprintf("%06d", code), nil
}

// TOTPNext returns the code of the next unused time step, waiting for it if the current step may have been
// used already (a code is accepted once, in strictly increasing steps). The wait is bounded by 30 s.
func TOTPNext(secret string, lastStep *int64) (string, error) {
	for {
		step := time.Now().Unix() / 30
		if step > *lastStep {
			*lastStep = step
			return TOTPAt(secret, step)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// ---- device keys ----

var b64 = base64.RawURLEncoding

// DeviceKey is an ES256 device key pair.
type DeviceKey struct {
	Priv *ecdsa.PrivateKey
}

// NewDeviceKey generates a fresh P-256 key.
func NewDeviceKey() DeviceKey {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
	return DeviceKey{k}
}

// JWK is the public JWK in the shape of the identity contract.
func (d DeviceKey) JWK() map[string]string {
	return map[string]string{"kty": "EC", "crv": "P-256",
		"x": b64.EncodeToString(d.Priv.PublicKey.X.FillBytes(make([]byte, 32))),
		"y": b64.EncodeToString(d.Priv.PublicKey.Y.FillBytes(make([]byte, 32)))}
}

func (d DeviceKey) rs(msg []byte) []byte {
	sum := sha256.Sum256(msg)
	r, s, err := ecdsa.Sign(rand.Reader, d.Priv, sum[:])
	if err != nil {
		panic(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return sig
}

// SignRaw signs msg (the registration nonce): raw r||s, base64url.
func (d DeviceKey) SignRaw(msg string) string { return b64.EncodeToString(d.rs([]byte(msg))) }

// Assertion builds an ES256 compact JWS over the claims (device assertion).
func (d DeviceKey) Assertion(claims map[string]any) string {
	h := b64.EncodeToString([]byte(`{"alg":"ES256","typ":"JWT"}`))
	pl, _ := json.Marshal(claims)
	p := b64.EncodeToString(pl)
	return h + "." + p + "." + b64.EncodeToString(d.rs([]byte(h+"."+p)))
}

// NewJTI is a random token id.
func NewJTI() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return b64.EncodeToString(b)
}
