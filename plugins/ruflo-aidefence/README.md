# ruflo-aidefence

AI safety scanning, PII detection, prompt injection defense, and adaptive threat learning.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-aidefence@ruflo
```

## Features

- **Safety scanning**: Detect prompt injection, jailbreak attempts, and adversarial content
- **PII detection**: Flag emails, SSNs, API keys, and other sensitive data
- **Adaptive learning**: Train defenses on confirmed threats to improve detection
- **Threat classification**: Categorize threats with confidence scores

## Commands

- `/aidefence` -- Detection stats and threat analysis dashboard

## Skills

- `safety-scan` -- Scan inputs for prompt injection and unsafe content
- `pii-detect` -- Detect PII in text, code, and configurations
