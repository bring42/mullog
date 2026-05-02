export const demoLog = `2026-05-02T08:41:03.112Z INFO [ingest.worker] accepted file id=R-1042 size=88412 bytes
2026-05-02T08:41:03.219Z DEBUG [encoding.detector] utf-8 candidate accepted confidence=0.92
2026-05-02T08:41:03.311Z WARN [parser.csv] row width variance detected expected=8 actual=9 line=4
    stack: CsvWidthWarning at parser.ts:218
2026-05-02T08:41:04.002Z INFO [schema.infer] categorical columns: severity,module,status
2026-05-02T08:41:05.883Z ERROR [exporter] failed first write attempt reason="locked file handle"
2026-05-02T08:41:06.001Z TRACE [exporter] retrying with blob url
2026-05-02T08:41:06.118Z INFO [exporter] csv export complete rows=417 duration_ms=117
scheduler: DEBUG next compaction pass in 30s
2026/05/02 08:42:12 WARN api.gateway: response latency over threshold route=/v1/events ms=1231
02.05.2026 08:42:19 ERROR auth.service: invalid signature for token kid=local-demo
`;

export const demoCsv = `timestamp;severity;module;status;message;duration_ms
2026-05-02T09:00:01Z;INFO;importer;ok;Opened local file;12
2026-05-02T09:00:02Z;DEBUG;encoding;ok;Detected UTF-8 without BOM;4
2026-05-02T09:00:03Z;WARN;parser;degraded;Row 8 has a trailing field;31
2026-05-02T09:00:04Z;ERROR;parser;failed;Unclosed quoted value;5
2026-05-02T09:00:05Z;INFO;export;ok;Filtered export ready;17
`;
