# ruflo-ruvllm

RuVLLM local inference with chat formatting, model configuration, and MicroLoRA fine-tuning.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-ruvllm@ruflo
```

## Features

- **Model configuration**: Generate optimal configs for local inference
- **MicroLoRA**: Task-specific fine-tuning with lightweight adapters
- **SONA adaptation**: Real-time neural adaptation (<0.05ms)
- **Chat formatting**: Multi-provider prompt formatting (Claude, GPT, Gemini, Ollama, Cohere)
- **HNSW routing**: Context retrieval for RAG pipelines

## Commands

- `/ruvllm` -- Model status, adapters, and provider availability

## Skills

- `llm-config` -- Configure models, MicroLoRA, and SONA
- `chat-format` -- Format prompts for different LLM providers
