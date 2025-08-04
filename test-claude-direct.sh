#!/bin/bash

echo "Testing Claude direct execution with stream-json output..."

claude --print --output-format stream-json --verbose "Create a hello world application in the directory './hello'. Tasks: 1) Create the directory if it doesn't exist using 'mkdir -p ./hello', 2) Create a hello.py file with a simple hello world program that prints 'Hello, World!' when run, 3) Create a README.md explaining how to run the program, 4) List the created files to confirm. Use the Bash and Write tools to complete these tasks. When done, just say 'Task completed' and exit."