#!/usr/bin/env node

import { program } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import ora from 'ora';
import { exec, spawn } from 'child_process';
import inquirer from 'inquirer';
import path from 'path';
import axios from 'axios';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.mycli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const LOG_DIR = path.join(os.homedir(), '.mycli_logs');
const LOG_FILE_PATH = path.join(LOG_DIR, 'my_terminal_session.log');


function readConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return null;
    }
    const configLines = fs.readFileSync(CONFIG_FILE, 'utf-8').split('\n').filter(Boolean);
    const config = {};
    for (const line of configLines) {
        const [key, value] = line.split('=');
        config[key] = value;
    }
    return config;
}

function writeConfig(config) {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const configLines = Object.entries(config).map(([key, value]) => `${key}=${value}`);
    fs.writeFileSync(CONFIG_FILE, configLines.join('\n'));
}


program
    .command('setup')
    .description('Setup your OpenAI API key and engine')
    .action(async () => {
        let currentConfig = readConfig() || {};

        const questions = [
            {
                type: 'input',
                name: 'apiKey',
                message: 'What is your OpenAI API key?',
                default: currentConfig.OPENAI_API_KEY,
                validate: input => input ? true : 'Please enter your API key'
            },
            {
                type: 'list',
                name: 'engine',
                message: 'Choose your OpenAI engine:',
                choices: ['gpt-3.5-turbo', 'gpt-4'],
                default: currentConfig.OPENAI_ENGINE || 'gpt-3.5-turbo'
            }
        ];

        const answers = await inquirer.prompt(questions);

        currentConfig.OPENAI_API_KEY = answers.apiKey;
        currentConfig.OPENAI_ENGINE = answers.engine;

        writeConfig(currentConfig);
        console.log('API key and engine saved.');
    });

program
    .command('start')
    .description('Start capturing terminal session')
    .action(() => {
        // Check if a `script` session is active using the PPID check
        exec('ps -p $PPID | grep script', (error, stdout) => {
            if (stdout) {
                console.error('It seems a script session is already active. Please type "exit" to end the session, and then run this command again.');
                return;
            }

            if (!fs.existsSync(LOG_DIR)) {
                fs.mkdirSync(LOG_DIR, { recursive: true });
            }

            // If not in a `script` session, start one
            const scriptProcess = spawn('script', [LOG_FILE_PATH], { stdio: 'inherit' });
            scriptProcess.on('exit', () => {
                console.log('Script session ended.');
            });
        });
    });

program
    .command('stop')
    .description('Stop the script session and optionally cleanup the log')
    .option('-c, --cleanup', 'Delete the log after stopping')
    .action((options) => {
        exec('ps -p $PPID | grep script', (error, stdout) => {
            if (stdout) {
                stopAndCleanup(options.cleanup);
                return;
            }
            console.error('It seems a script is not running.');
        })
    });


program
    .command('prompt')
    .description('Ask any question to OpenAI')
    .action(async () => {
        await promptUserAndSendToOpenAI();
    });


program
    .command('explain')
    .description('Explain the last error from terminal')
    .action(async () => {
        // Check if the log file exists
        if (!fs.existsSync(LOG_FILE_PATH)) {
            console.error('Cannot find terminal log file. Ensure you started a "script" session.');
            return;
        }

        // Read the log file
        const rawLogContent = fs.readFileSync(LOG_FILE_PATH, 'utf-8');
        // Split the log content into lines
        const lines = rawLogContent.split('\n').filter(Boolean);
        console.log('Lines:', lines);

        let command = null;
        let output = [];
        let foundPrompt = false;

        // Start from the end of the log and move upwards
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
        
            // Check if the line matches the terminal prompt pattern
            if (line.includes(' % ') || line.includes(' $ ')) {
                if (foundPrompt) {  // If we already found a prompt before, this is the beginning of the command
                    command = lines[i - 1];
                    break;
                }
                foundPrompt = true;
            } else if (foundPrompt) {  // If we found the prompt and are still collecting output
                output.unshift(line);  // Add the output line to the beginning of the array to maintain order
            }
        }
        
        console.log('Last Command:', command);
        console.log('Output:', output);

        const prompt = `Command: ${command}\nOutput: ${output}\nGive me an explanation for this terminal error:`;
        console.log('Prompt:', prompt);
        const explanation = await askOpenAI(prompt, 100);
        if (!explanation) {
            console.error('Sorry, something went wrong.');
            return;
        }
        console.log('='.repeat(50));
        console.log('Explanation:', stylizeCodeBlocks(explanation));
        console.log('='.repeat(50));
    });


// Command to modify only the API Key
program
    .command('change-key')
    .description('Change your OpenAI API key')
    .action(async () => {
        let currentConfig = readConfig();

        if (!currentConfig) {
            console.error('Please run the setup command first.');
            return;
        }

        const questions = [
            {
                type: 'input',
                name: 'apiKey',
                message: 'What is your new OpenAI API key?',
                default: currentConfig.OPENAI_API_KEY,
                validate: input => input ? true : 'Please enter your API key'
            }
        ];

        const answers = await inquirer.prompt(questions);

        currentConfig.OPENAI_API_KEY = answers.apiKey;

        writeConfig(currentConfig);
        console.log('API key updated.');
    });

// Command to modify only the Engine
program
    .command('change-engine')
    .description('Change your OpenAI engine')
    .action(async () => {
        let currentConfig = readConfig();

        if (!currentConfig) {
            console.error('Please run the setup command first.');
            return;
        }

        const questions = [
            {
                type: 'list',
                name: 'engine',
                message: 'Choose your new OpenAI engine:',
                choices: ['gpt-3.5-turbo', 'gpt-4'],
                default: currentConfig.OPENAI_ENGINE
            }
        ];

        const answers = await inquirer.prompt(questions);

        currentConfig.OPENAI_ENGINE = answers.engine;

        writeConfig(currentConfig);
        console.log('Engine updated.');
    });



// Parse the command-line arguments
program.parse(process.argv);

async function promptUserAndSendToOpenAI() {
    const questions = [
        {
            type: 'input',
            name: 'userQuery',
            message: 'Please enter your question for OpenAI:',
            validate: input => input ? true : 'Please enter a question'
        }
    ];

    const answers = await inquirer.prompt(questions);
    const userQuestion = answers.userQuery;

    const response = await askOpenAI(userQuestion, 100); // Using 100 tokens, adjust as needed
    if (!response) {
        console.error('Sorry, something went wrong.');
        return;
    }
    console.log('OpenAI Response:', stylizeCodeBlocks(response));
}

function stopAndCleanup(cleanup) {
    // Here you can add logic to check if the script session is still running 
    // (this depends on how you handle the script process in your actual implementation)

    if (cleanup && fs.existsSync(LOG_FILE_PATH)) {
        fs.unlinkSync(LOG_FILE_PATH);
        console.log('Script session stopped and log file cleaned up.');
    } else {
        console.log('Script session stopped.');
    }
}

// Use the config in your askOpenAI function

// Use the config in your askOpenAI function
async function askOpenAI(question, maxTokens) {
    const config = readConfig();
    if (!config || !config.OPENAI_API_KEY || !config.OPENAI_ENGINE) {
        console.error('Please run the setup command first.');
        return null;
    }

    const openaiUrl = `https://api.openai.com/v1/chat/completions`;
    const openaiHeaders = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.OPENAI_API_KEY
    };

    const openaiData = {
        model: config.OPENAI_ENGINE,
        messages: [
            {
                role: 'user',
                content: question
            }
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
        top_p: 1,
        n: 1,
        stream: false,
    };

    // Initialize the spinner
    const spinner = ora('Thinking...').start();

    try {
        const response = await axios.post(openaiUrl, openaiData, { headers: openaiHeaders });
        spinner.stop(); // Stop the spinner once the request is completed
        return response.data.choices[0].message.content.trim();
    } catch (error) {
        spinner.stop(); // Stop the spinner if there's an error
        console.error('Sorry, something went wrong.', error);
        return null;
    }
}


function stylizeCodeBlocks(message) {
    let isInsideCodeBlock = false;
    let result = '';

    // Split the message by code block delimiters
    const segments = message.split('```');

    for (let segment of segments) {
        if (isInsideCodeBlock) {
            // If the segment was inside delimiters, stylize it
            result += chalk.bgBlack(chalk.white(segment));
        } else {
            // If not, just append it as is
            result += segment;
        }

        // Toggle the flag for the next segment
        isInsideCodeBlock = !isInsideCodeBlock;
    }

    return result;
}


function preprocessLog(logContent) {
    // Remove escape sequences
    let cleanedContent = logContent.replace(/\x1B\[([0-9]{1,2}(;[0-9]{1,2})?)?[mGK]/g, '');
    console.log('Cleaned content:', cleanedContent);
    // Any other preprocessing can be added here
    // ...

    return cleanedContent;
}




