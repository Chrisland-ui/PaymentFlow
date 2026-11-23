# Container Security

This document describes how PaymentFlow scans its Docker images for vulnerabilities, what the severity thresholds mean, and how to handle findings.

---

## Overview

Every push and pull request targeting `main`, plus a weekly scheduled run, triggers the **Container Image Vulnerability Scan** workflow (`.github/workflows/container-scan.yml`). The workflow:

1. Builds the `backend` and `frontend` images from their respective `Dockerfile`s.
2. Scans each image with **[Trivy](https://github.com/aquasecurity/trivy)** (pinned to `aquasecurity/trivy-action@0.28.0`).
3. Emits results in **SARIF** (Static Analysis Results Interchange Format) and uploads them to the **GitHub Security tab** (Security → Code scanning alerts), where they persist indefinitely.
4. Also uploads the raw SARIF file as a build artifact (retained for **30 days**) for offline review.

The backend and frontend scans run as **parallel jobs** (`scan-backend`, `scan-frontend`) so a failure is immediately attributed to the correct image. A `scan-gate` job that `needs` both scan jobs acts as the single required status check for branch protection.

---

## Severity Thresholds

| Severity | Action |
|----------|--------|
| **CRITICAL** | Blocks the build immediately. Must be fixed (upgrade the base image or affected package) or an approved exception must be created before the branch can merge. |
| **HIGH** | Blocks the build unless an owner-approved exception exists in `security-exceptions.json`. Exceptions require sign-off and expire after a maximum of 90 days. |
| **MEDIUM** | Tracked in SARIF / Security tab but **non-blocking**. Should be reviewed within 30 days and scheduled for remediation. |
| **LOW** | Tracked in SARIF / Security tab but **non-blocking**. Addressed opportunistically during routine base-image upgrades. |

Only **unfixed** vulnerabilities (those with a known fix available) cause the build to fail (`ignore-unfixed: true`). A vulnerability with no available fix appears in the SARIF results for visibility but does not block the workflow.

---

## Exception Process

When a CRITICAL or HIGH finding cannot be fixed immediately (e.g., the upstream package has not released a patch, or the finding is in a layer the team does not control), an approved exception may be created:

1. **Identify the CVE** from the Security tab or artifact SARIF file.
2. **Assess exploitability** — is the vulnerable code path reachable in this container's runtime context?
3. **Create an exception entry** in `security-exceptions.json` under the `"container_scan_exceptions"` array with all required fields:

   ```json
   {
     "cve_id": "CVE-YYYY-NNNNN",
     "image": "paymentflow/backend",
     "owner": "Your Name <you@example.com>",
     "expires": "YYYY-MM-DD",
     "justification": "Explain why this cannot be fixed now and why the risk is acceptable.",
     "risk_accepted_by": "Engineering Lead Name"
   }
   ```

   - `expires` must be no more than **90 days** from the date of creation.
   - `risk_accepted_by` must be a named individual with authority to accept security risk (typically the engineering lead or security officer).

4. **Open a tracking issue** referencing the CVE and the expiration date so the exception is revisited before it expires.
5. **Suppress the finding in Trivy** by adding the CVE to `.trivyignore` (see [Suppressing False Positives](#suppressing-false-positives) below). Without this step the workflow will continue to fail even with a logged exception.

> **Expired exceptions are not automatically honoured.** If an exception's `expires` date has passed and the CVE has not been remediated, the build will block again until a new exception is approved or the vulnerability is fixed.

---

## Viewing Scan Results

1. Navigate to your repository on GitHub.
2. Click the **Security** tab.
3. Select **Code scanning alerts** from the left sidebar.
4. Filter by tool: select **Trivy** to see only container scan results.
5. Each alert shows the CVE ID, affected package, severity, and the image/layer where it was found.

SARIF results are also available as downloadable artifacts from the workflow run (retained 30 days): Actions → select the workflow run → Artifacts → `trivy-backend-sarif` / `trivy-frontend-sarif`.

---

## Suppressing False Positives

If a finding is a confirmed false positive (e.g., the package is present in the image but the vulnerable code path is not compiled or reachable), suppress it by adding the CVE ID to a `.trivyignore` file at the repository root:

```
# .trivyignore
# Format: one CVE ID per line. Comments start with #.
# Include a comment explaining why the suppression is safe.

# CVE-YYYY-NNNNN: <brief justification>
CVE-YYYY-NNNNN
```

Trivy reads `.trivyignore` automatically during the scan. The suppressed finding will no longer appear in the SARIF output or cause the build to fail.

Keep `.trivyignore` entries minimal and periodically review them — a suppressed CVE may later receive a fix that makes suppression unnecessary.

---

## Artifact Retention

| Artifact | Location | Retention |
|----------|----------|-----------|
| Raw SARIF files | GitHub Actions artifacts (`trivy-backend-sarif`, `trivy-frontend-sarif`) | **30 days** |
| Code scanning alerts | GitHub Security tab | **Indefinitely** (until dismissed or the alert is resolved) |

---

## Related Resources

- **npm audit exceptions** — `security-exceptions.json` (under `"exceptions"`) and the process in [`docs/dependency-triage.md`](dependency-triage.md)
- **Threat model** — [`docs/threat-model.md`](threat-model.md)
- **Security overview** — [`docs/security.md`](security.md)
- **Trivy documentation** — https://aquasecurity.github.io/trivy/
- **SARIF specification** — https://docs.oasis-open.org/sarif/sarif/v2.1.0/
