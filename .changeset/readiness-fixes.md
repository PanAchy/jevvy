---
"jevvy": patch
---

Security and packaging fixes from the readiness review: quote-aware comment stripping (a quoted hash could swallow a dangerous tail), proven tier refuses redirections and command substitution and no longer treats `cat` as read-only, CLI redacts task text and sends only the directory name, and the package ships compiled dist so it runs from node_modules.
