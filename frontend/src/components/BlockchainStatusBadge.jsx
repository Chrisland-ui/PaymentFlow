import React from "react";

export default function BlockchainStatusBadge({ status, className = "", style = {} }) {
  const normalized = (status || "unknown").toLowerCase();
  const labelMap = {
    connected: "Connected",
    syncing: "Syncing",
    delayed: "Delayed",
    disconnected: "Disconnected",
    unknown: "Unknown",
  };

  const toneMap = {
    connected: "badge badge-success",
    syncing: "badge badge-warning",
    delayed: "badge badge-warning",
    disconnected: "badge badge-danger",
    unknown: "badge badge-secondary",
  };

  return (
    <span
      className={`${toneMap[normalized] || toneMap.unknown} ${className}`.trim()}
      style={style}
      aria-label={`Blockchain status: ${labelMap[normalized] || labelMap.unknown}`}
    >
      {labelMap[normalized] || labelMap.unknown}
    </span>
  );
}
