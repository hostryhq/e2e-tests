package stack

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
)

// keyFiles holds every throw-away key the local stack needs. Generated per run; nothing here is a secret.
type keyFiles struct {
	Dir                         string
	Tenant, Vendor, Pack        string // PEM PKCS#8 P-256 (identity token signing)
	MAC, Proof, TOTP            string // base64, 32 bytes
	IdentitySvcKey, AdminSvcKey string // PEM PKCS#8 service-token keys
	ServiceKeysDir              string // <svc>.pub.pem registry read by identity
	ServiceJWKS                 string // JWKS registry read by tenancy (kid = service name)
	OpPub                       string // PEM public key standing in for the sync op-signing key
}

func genEC() *ecdsa.PrivateKey {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(err)
	return k
}

func writePriv(path string, k *ecdsa.PrivateKey) {
	der, err := x509.MarshalPKCS8PrivateKey(k)
	must(err)
	must(os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600))
}

func writePub(path string, k *ecdsa.PrivateKey) {
	der, err := x509.MarshalPKIXPublicKey(&k.PublicKey)
	must(err)
	must(os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o644))
}

func writeB64(path string) {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	must(os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(b)), 0o600))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func generateKeys(dir string) keyFiles {
	must(os.MkdirAll(filepath.Join(dir, "svckeys"), 0o700))
	k := keyFiles{Dir: dir}
	p := func(n string) string { return filepath.Join(dir, n) }
	k.Tenant, k.Vendor, k.Pack = p("tenant.pem"), p("vendor.pem"), p("pack.pem")
	for _, f := range []string{k.Tenant, k.Vendor, k.Pack} {
		writePriv(f, genEC())
	}
	k.MAC, k.Proof, k.TOTP = p("mac.b64"), p("proof.b64"), p("totp.b64")
	for _, f := range []string{k.MAC, k.Proof, k.TOTP} {
		writeB64(f)
	}
	idk, adk, opk := genEC(), genEC(), genEC()
	k.IdentitySvcKey, k.AdminSvcKey = p("identity-svc.pem"), p("admin-svc.pem")
	writePriv(k.IdentitySvcKey, idk)
	writePriv(k.AdminSvcKey, adk)
	k.ServiceKeysDir = filepath.Join(dir, "svckeys")
	writePub(filepath.Join(k.ServiceKeysDir, "admin.pub.pem"), adk)
	k.OpPub = p("op.pub.pem")
	writePub(k.OpPub, opk)
	jwk := func(kid string, key *ecdsa.PrivateKey) map[string]string {
		return map[string]string{"kty": "EC", "crv": "P-256", "kid": kid, "alg": "ES256", "use": "sig",
			"x": base64.RawURLEncoding.EncodeToString(key.PublicKey.X.FillBytes(make([]byte, 32))),
			"y": base64.RawURLEncoding.EncodeToString(key.PublicKey.Y.FillBytes(make([]byte, 32)))}
	}
	doc, _ := json.Marshal(map[string]any{"keys": []any{jwk("identity", idk), jwk("admin", adk)}})
	k.ServiceJWKS = p("service-jwks.json")
	must(os.WriteFile(k.ServiceJWKS, doc, 0o644))
	return k
}
