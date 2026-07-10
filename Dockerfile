# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM golang:1.25-alpine AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /carrot-server ./cmd/server

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /carrot-server .
COPY web ./web
COPY carrot.conf ./config/

EXPOSE 7777 1935

ENTRYPOINT ["./carrot-server", "-config=config/carrot.conf"]
