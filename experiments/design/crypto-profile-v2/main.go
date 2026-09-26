package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark-crypto/ecc/bn254/fp"
)

const domain = "ECU_BP_BN254_G1_V2"

type vector struct {
	Role  string `json:"role"`
	Index uint32 `json:"index"`
	Input string `json:"inputHex"`
	X     string `json:"xHex"`
	Y     string `json:"yHex"`
}

type output struct {
	Library          string   `json:"library"`
	Domain           string   `json:"dstAscii"`
	Encoding         string   `json:"messageEncoding"`
	OrderedDigest    string   `json:"orderedSha256"`
	GeneratorCount   int      `json:"generatorCount"`
	GeneratorVectors []vector `json:"generators"`
}

func main() {
	roles := []struct {
		name  string
		code  byte
		count uint32
	}{
		{"blindingBase", 1, 1},
		{"valueBase", 2, 1},
		{"vectorG", 3, 64},
		{"vectorH", 4, 64},
	}

	result := output{
		Library:  "github.com/consensys/gnark-crypto v0.20.1",
		Domain:   domain,
		Encoding: "ASCII ECU || 0x02 || role byte || uint32 big-endian index",
	}
	seen := make(map[string]bool)
	digest := sha256.New()
	for _, role := range roles {
		for index := uint32(0); index < role.count; index++ {
			message := make([]byte, 9)
			copy(message, []byte("ECU"))
			message[3] = 2
			message[4] = role.code
			binary.BigEndian.PutUint32(message[5:], index)
			point, err := bn254.HashToG1(message, []byte(domain))
			if err != nil {
				panic(err)
			}
			if point.IsInfinity() || !point.IsOnCurve() || !point.IsInSubGroup() {
				panic(fmt.Sprintf("invalid %s[%d]", role.name, index))
			}
			x, y := point.X.Bytes(), point.Y.Bytes()
			var canonicalX, canonicalY fp.Element
			if canonicalX.SetBytesCanonical(x[:]) != nil || canonicalY.SetBytesCanonical(y[:]) != nil {
				panic(fmt.Sprintf("noncanonical %s[%d]", role.name, index))
			}
			key := hex.EncodeToString(x[:]) + hex.EncodeToString(y[:])
			if seen[key] {
				panic(fmt.Sprintf("duplicate %s[%d]", role.name, index))
			}
			seen[key] = true
			digest.Write(x[:])
			digest.Write(y[:])
			result.GeneratorVectors = append(result.GeneratorVectors, vector{
				Role: role.name, Index: index, Input: hex.EncodeToString(message),
				X: hex.EncodeToString(x[:]), Y: hex.EncodeToString(y[:]),
			})
		}
	}
	result.GeneratorCount = len(result.GeneratorVectors)
	result.OrderedDigest = hex.EncodeToString(digest.Sum(nil))
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(result); err != nil {
		panic(err)
	}
}
