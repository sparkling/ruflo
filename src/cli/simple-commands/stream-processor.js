/**
 * Stream processor for Claude stream-json output
 * Provides real-time status updates and progress tracking
 */

import { Transform } from 'stream';

export class StreamJsonProcessor extends Transform {
  constructor(options = {}) {
    super({ objectMode: false });
    this.buffer = '';
    this.agentId = options.agentId;
    this.agentName = options.agentName || 'Agent';
    this.agentIcon = options.agentIcon || '🤖';
    this.taskId = options.taskId || 'unknown';
    this.startTime = Date.now();
    this.eventCount = 0;
    this.lastUpdate = Date.now();
    this.options = options;
    this.display = options.display; // Reference to concurrent display
  }

  _transform(chunk, encoding, callback) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const event = JSON.parse(line);
          this.processEvent(event);
        } catch (e) {
          // Not JSON, pass through if in verbose mode
          if (this.options.verbose) {
            console.log(`[${this.agentName}] ${line}`);
          }
        }
      }
    }

    // Update progress display periodically
    if (Date.now() - this.lastUpdate > 1000) {
      this.updateProgress();
      this.lastUpdate = Date.now();
    }

    callback();
  }

  _flush(callback) {
    if (this.buffer.trim()) {
      try {
        const event = JSON.parse(this.buffer);
        this.processEvent(event);
      } catch (e) {
        // Ignore
      }
    }
    this.showFinalStatus();
    callback();
  }

  processEvent(event) {
    this.eventCount++;
    
    // If we have a concurrent display, update it instead of console logging
    if (this.display) {
      this.updateDisplay(event);
      return;
    }
    
    // Use interactive-style formatting for non-interactive mode
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          console.log(`\n● ${this.agentName} - Agent Initialized`);
          console.log(`  ⎿  Session: ${event.session_id?.substring(0, 8) || 'unknown'}`);
        }
        break;
        
      case 'assistant':
        if (event.message?.content?.length > 0) {
          const content = event.message.content[0];
          if (content.type === 'text') {
            // Format text content with bullet and indentation
            const lines = content.text.split('\n');
            console.log(`\n● ${lines[0] || 'Processing...'}`);
            if (lines.length > 1) {
              lines.slice(1, 3).forEach(line => {
                if (line.trim()) {
                  console.log(`  ⎿  ${line.trim()}`);
                }
              });
              if (lines.length > 3) {
                console.log(`  … +${lines.length - 3} lines (ctrl+r to expand)`);
              }
            }
          } else if (content.type === 'tool_use') {
            // Format tool calls like interactive mode
            const params = content.input ? this.formatToolParams(content.input) : '';
            console.log(`\n● ${this.agentName} - ${content.name}${params}`);
            
            // Show formatted input if available
            if (content.input && Object.keys(content.input).length > 0) {
              const inputStr = JSON.stringify(content.input, null, 2);
              if (inputStr.length > 200) {
                const preview = JSON.stringify(content.input, null, 0).substring(0, 100);
                console.log(`  ⎿  ${preview}...`);
                console.log(`  … +${inputStr.split('\n').length - 1} lines (ctrl+r to expand)`);
              } else {
                console.log(`  ⎿  ${inputStr.split('\n').map(l => l.trim()).filter(l => l).join(' ')}`);
              }
            }
          }
        }
        break;
        
      case 'user':
        // Tool results - format like interactive mode
        if (event.message?.content?.[0]?.type === 'tool_result') {
          const result = event.message.content[0];
          if (!result.is_error) {
            if (result.content) {
              try {
                const parsed = typeof result.content === 'string' 
                  ? JSON.parse(result.content) 
                  : result.content;
                
                if (typeof parsed === 'object') {
                  console.log(`  ⎿  {`);
                  const keys = Object.keys(parsed).slice(0, 3);
                  keys.forEach(key => {
                    const value = JSON.stringify(parsed[key]);
                    const displayValue = value.length > 50 ? value.substring(0, 47) + '...' : value;
                    console.log(`       "${key}": ${displayValue},`);
                  });
                  if (Object.keys(parsed).length > 3) {
                    console.log(`     … +${Object.keys(parsed).length - 3} lines (ctrl+r to expand)`);
                  } else {
                    // Remove last comma
                    process.stdout.write('\x1B[1A\x1B[K'); // Move up and clear line
                    const lastKey = keys[keys.length - 1];
                    const value = JSON.stringify(parsed[lastKey]);
                    const displayValue = value.length > 50 ? value.substring(0, 47) + '...' : value;
                    console.log(`       "${lastKey}": ${displayValue}`);
                  }
                  console.log(`     }`);
                } else {
                  console.log(`  ⎿  ${result.content.substring(0, 100)}${result.content.length > 100 ? '...' : ''}`);
                }
              } catch (e) {
                console.log(`  ⎿  ${result.content.substring(0, 100)}${result.content.length > 100 ? '...' : ''}`);
              }
            } else {
              console.log(`  ⎿  Tool completed successfully`);
            }
          } else {
            console.log(`  ⎿  ❌ Error: ${result.error || 'Unknown error'}`);
          }
        }
        break;
        
      case 'result':
        if (event.subtype === 'success') {
          console.log(`\n● ✅ ${this.agentName} completed successfully`);
          console.log(`  ⎿  Duration: ${this.formatDuration(event.duration_ms)}`);
          if (event.total_cost_usd) {
            console.log(`  ⎿  Cost: $${event.total_cost_usd.toFixed(4)}`);
          }
        } else if (event.is_error) {
          console.log(`\n● ❌ ${this.agentName} failed`);
          console.log(`  ⎿  Error: ${event.error || 'Unknown error'}`);
        }
        break;
        
      default:
        if (this.options.verbose) {
          console.log(`\n● [${event.type}] ${JSON.stringify(event).substring(0, 100)}...`);
        }
    }
  }
  
  /**
   * Update the concurrent display instead of console
   */
  updateDisplay(event) {
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          this.display.updateAgent(this.agentId, { status: 'active' });
          this.display.addActivity(this.agentId, 'Initialized');
        }
        break;
        
      case 'assistant':
        if (event.message?.content?.length > 0) {
          const content = event.message.content[0];
          if (content.type === 'text') {
            const preview = content.text.substring(0, 80);
            this.display.addActivity(this.agentId, preview);
          } else if (content.type === 'tool_use') {
            this.display.addActivity(this.agentId, `Using ${content.name}`, content.name);
          }
        }
        break;
        
      case 'user':
        // Tool results
        if (event.message?.content?.[0]?.type === 'tool_result') {
          const result = event.message.content[0];
          if (!result.is_error) {
            this.display.addActivity(this.agentId, 'Tool completed', null);
          }
        }
        break;
        
      case 'result':
        if (event.subtype === 'success') {
          this.display.updateAgent(this.agentId, { 
            status: 'completed',
            progress: 100
          });
          this.display.addActivity(this.agentId, 'Task completed successfully');
        } else if (event.is_error) {
          this.display.updateAgent(this.agentId, { 
            status: 'failed'
          });
          this.display.addActivity(this.agentId, `Failed: ${event.error || 'Unknown error'}`);
        }
        break;
    }
  }

  updateProgress() {
    const elapsed = this.formatDuration(Date.now() - this.startTime);
    const spinner = this.getSpinner();
    const progress = this.getProgressBar(Date.now() - this.startTime, 60000);
    
    process.stdout.write(`\r    ${spinner} ${this.agentName} ${progress} ${elapsed} | Events: ${this.eventCount}`);
  }

  showFinalStatus() {
    const elapsed = this.formatDuration(Date.now() - this.startTime);
    console.log(`\n    📊 ${this.agentName} processed ${this.eventCount} events in ${elapsed}`);
  }

  getSpinner() {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    return frames[Math.floor(Date.now() / 100) % frames.length];
  }

  getProgressBar(elapsed, expected) {
    const progress = Math.min(elapsed / expected, 1);
    const filled = Math.floor(progress * 10);
    const empty = 10 - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
  }

  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }
}

/**
 * Create a stream processor for an agent
 */
export function createStreamProcessor(agentName, agentIcon, options = {}) {
  return new StreamJsonProcessor({
    agentName,
    agentIcon,
    ...options
  });
}