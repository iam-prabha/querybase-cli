# 0007. Production readiness — Rationale

## Context
Querybase is a CLI tool that turns documentation sites into searchable knowledge bases. It has reached feature completeness for its core pipeline (crawl → index → ask) and Docker deployment, but lacks production hardening: no structured logging, metrics, health checks, rate limiting, audit logging, secret rotation, backup/restore, or staging pipeline. The workflow is Prototype tier; this spec moves it toward production readiness for single-tenant, small-scale use.

## Options considered

### Logging
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| `pino` | Fast, JSON, child loggers, pretty dev, 0 deps in prod | One more dep | **Chosen** |
| `winston` | Mature, many transports | Heavier, slower | |
| Custom wrapper | Zero deps | Reinventing wheels | |

### Metrics
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| `prom-client` | Prometheus standard, simple, works with any scraper | One more dep | **Chosen** |
| OpenTelemetry | Vendor neutral | Overkill for CLI | |
| Custom counters | Zero deps | No standardization | |

### Rate limiting
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Postgres token bucket | Survives restarts, no Redis, works at small scale | ~2ms latency per request | **Chosen** |
| In-memory | Zero latency, simple | Resets on restart, no multi-instance | |
| Redis | Scales, feature-rich | New infra, overkill | |

### Secret rotation
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Env var + CLI | Zero external deps, simple | Manual env update | **Chosen** |
| AWS Secrets Manager / Vault | Automated, audit trail | New infra, cost, complexity | |
| Manual .env edit | Current state | Downtime, error-prone | |

### Backup/restore
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| `pg_dump`/`pg_restore` | Standard, portable, no new tools | Requires quiesce | **Chosen** |
| WAL-G / Barman | Continuous, point-in-time | Complex, overkill | |
| Volume snapshots | Fast | Infra-dependent, not portable | |

### Staging Qdrant
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Qdrant local mode (embedded) | Free, no cloud account, fast startup | Not identical to cloud | **Chosen** |
| Dev cloud cluster | Production parity | Cost, setup, credentials | |

### Circuit breaker
| Config | Rationale |
|--------|-----------|
| 5 failures / 30s window | Balances sensitivity vs noise for small scale; tunes via env if needed |
| 30s timeout | Generous for NVIDIA/Scraper Studio latency |
| 3x exponential backoff | Standard retry pattern |

## References
- [pino docs](https://getpino.io/)
- [prom-client docs](https://github.com/siimon/prom-client)
- [PostgreSQL advisory locks for rate limiting](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)
- [pg_dump documentation](https://www.postgresql.org/docs/current/app-pgdump.html)
- [Qdrant local mode](https://qdrant.tech/documentation/guides/local-mode/)
- [GitHub Actions workflow_dispatch](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#workflow_dispatch)