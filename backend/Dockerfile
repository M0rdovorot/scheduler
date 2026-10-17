# Build context is the repository root: docker build -f backend/Dockerfile .
FROM golang:1.27-alpine AS build
# Some modules are not served by proxy.golang.org from this region: fetch them directly.
RUN apk add --no-cache git
ENV GOPROXY=direct CGO_ENABLED=0
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend ./
RUN go build -trimpath -ldflags="-s -w" -o /out/scheduler ./cmd/scheduler

FROM alpine:3.20
# CA certificates: the bot talks to api.telegram.org over TLS. Time zones are built into the binary.
RUN apk add --no-cache ca-certificates && adduser -D -H -u 10001 scheduler
COPY --from=build /out/scheduler /usr/local/bin/scheduler
USER scheduler
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:8081/api/v1/healthz || exit 1
ENTRYPOINT ["scheduler"]
