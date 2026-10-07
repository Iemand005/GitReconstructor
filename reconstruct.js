#!/usr/bin/env node

/**
 * GitReconstructor - Main Entry Point
 * 
 * Unified interface for reconstructing git repositories from file backups/copies.
 * 
 * Usage:
 *   node reconstruct.js
 *   node reconstruct.js <repo-name> [--auto-approve]
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const exec = require('child_process').exec;
const { promisify: p } = require('util');
const execAsync = p(exec);

// ANSI colors
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m', 
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    bold: '\x1b[1m',
    dim: '\x1b[2m'
};

/**
 * Display a header
 */
function displayHeader(title) {
    console.log(colors.cyan + '\n' + '='.repeat(60));
    console.log(title.padStart(30 + Math.floor(30/2)));
    console.log('='.repeat(60) + colors.reset);
}

/**
 * List available repositories in the Repos directory
 */
async function listAvailableRepos() {
    const reposDir = path.join(process.cwd(), 'Repos');
    
    try {
        const exists = await fs.promises.access(reposDir).then(() => true).catch(() => false);
        if (!exists) {
            console.log(colors.yellow + 'No Repos directory found.' + colors.reset);
            return [];
        }
        
        const items = await readdir(reposDir);
        const repos = [];
        
        for (const item of items) {
            const fullPath = path.join(reposDir, item);
            const itemStat = await stat(fullPath);
            
            if (itemStat.isDirectory() && !item.startsWith('.')) {
                repos.push(item);
            }
        }
        
        return repos;
    } catch (error) {
        console.log(colors.yellow + `Warning: Could not read Repos directory: ${error.message}` + colors.reset);
        return [];
    }
}

/**
 * Ask user to select from a list of options
 */
async function selectFromList(question, options, allowCustom = false) {
    return new Promise((resolve) => {
        console.log(colors.bold + `\n${question}` + colors.reset);
        
        options.forEach((option, index) => {
            console.log(colors.white + `  ${index + 1}. ${option}` + colors.reset);
        });
        
        if (allowCustom) {
            console.log(colors.white + `  0. Enter custom directory` + colors.reset);
        }
        
        console.log(colors.white + `  q. Quit` + colors.reset);
        
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        const listener = (input) => {
            rl.close();
            
            const trimmed = input.trim().toLowerCase();
            
            if (trimmed === 'q') {
                resolve(null);
                return;
            }
            
            if (trimmed === '0' && allowCustom) {
                resolve('CUSTOM');
                return;
            }
            
            const index = parseInt(trimmed) - 1;
            if (index >= 0 && index < options.length) {
                resolve(options[index]);
                return;
            }
            
            // Default to first option
            resolve(options[0]);
        };
        
        rl.on('line', listener);
        
        const cleanup = () => {
            rl.off('line', listener);
        };
        
        const originalResolve = resolve;
        resolve = (value) => {
            cleanup();
            originalResolve(value);
        };
    });
}

/**
 * Ask yes/no question
 */
async function askYesNo(question) {
    return new Promise((resolve) => {
        console.log(colors.bold + `\n${question} ` + colors.reset + `[Y/n]`);
        
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        const listener = (input) => {
            rl.close();
            const trimmed = input.trim().toLowerCase();
            resolve(trimmed === 'y' || trimmed === 'yes' || trimmed === '');
        };
        
        rl.on('line', listener);
        
        const cleanup = () => {
            rl.off('line', listener);
        };
        
        const originalResolve = resolve;
        resolve = (value) => {
            cleanup();
            originalResolve(value);
        };
    });
}

/**
 * Check if the reconstruction JSON already exists
 */
async function checkReconstructionExists(repoName, format = 'commits') {
    const jsonPath = path.join(process.cwd(), `${repoName}-${format}.json`);
    try {
        await fs.promises.access(jsonPath);
        return jsonPath;
    } catch (error) {
        return null;
    }
}

/**
 * Run the reconstruction process
 */
async function runReconstruction(repoName, autoApprove, outputDir) {
    const sourceDir = path.join(process.cwd(), 'Repos', repoName);
    
    // Step 1: Create reconstruction JSON if it doesn't exist
    const historyJsonPath = path.join(process.cwd(), `${repoName}-history.json`);
    const commitsJsonPath = path.join(process.cwd(), `${repoName}-commits.json`);
    
    let jsonPath = await checkReconstructionExists(repoName, 'commits');
    if (!jsonPath) {
        jsonPath = await checkReconstructionExists(repoName, 'history');
    }
    
    if (!jsonPath) {
        console.log(colors.blue + `\nStep 1: Creating reconstruction JSON...` + colors.reset);
        console.log(colors.blue + `Scanning: ${sourceDir}` + colors.reset);
        
        // Run gitReconstructor to create the JSON
        const { spawn } = require('child_process');
        const reconstructor = spawn('node', ['gitReconstructor.js', sourceDir, commitsJsonPath, '-f', 'git']);
        
        reconstructor.stdout.on('data', (data) => {
            process.stdout.write(data);
        });
        
        reconstructor.stderr.on('data', (data) => {
            process.stderr.write(data);
        });
        
        await new Promise((resolve, reject) => {
            reconstructor.on('close', (code) => {
                if (code === 0) {
                    console.log(colors.green + `✓ Reconstruction JSON created: ${commitsJsonPath}` + colors.reset);
                    resolve();
                } else {
                    reject(new Error('Reconstruction failed'));
                }
            });
        });
        
        jsonPath = commitsJsonPath;
    } else {
        console.log(colors.green + `✓ Using existing reconstruction: ${jsonPath}` + colors.reset);
    }
    
    // Step 2: Create git repository
    console.log(colors.blue + `\nStep 2: Creating git repository...` + colors.reset);
    
    const cliArgs = ['gitReconstructorCLI.js', jsonPath, '-o', outputDir];
    if (autoApprove) {
        cliArgs.push('--auto-approve');
    }
    
    const { spawn } = require('child_process');
    const cli = spawn('node', cliArgs);
    
    cli.stdout.on('data', (data) => {
        process.stdout.write(data);
    });
    
    cli.stderr.on('data', (data) => {
        process.stderr.write(data);
    });
    
    await new Promise((resolve, reject) => {
        cli.on('close', (code) => {
            if (code === 0) {
                console.log(colors.green + `\n✓ Git repository created successfully!` + colors.reset);
                resolve();
            } else {
                reject(new Error('Git reconstruction failed'));
            }
        });
    });
}

/**
 * Parse command line arguments
 */
function parseArguments() {
    const args = process.argv.slice(2);
    const options = {
        repo: null,
        autoApprove: false,
        outputDir: null,
        help: false
    };
    
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        
        if (arg === '--auto-approve' || arg === '-a') {
            options.autoApprove = true;
            i++;
        } else if (arg === '--output' || arg === '-o') {
            options.outputDir = args[++i];
            i++;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg.startsWith('--')) {
            console.error(`Unknown option: ${arg}`);
            process.exit(1);
        } else {
            if (options.repo === null) {
                options.repo = arg;
            } else {
                console.error(`Unexpected argument: ${arg}`);
                process.exit(1);
            }
            i++;
        }
    }
    
    return options;
}

/**
 * Show help
 */
function showHelp() {
    console.log(`
GitReconstructor - Reconstruct Git Repositories from File Backups

Usage:
  node reconstruct.js                    # Interactive mode
  node reconstruct.js <repo-name>       # Select specific repository
  node reconstruct.js <repo> -a         # Auto-approve all files

Options:
  <repo-name>          Name of repository in Repos/ directory
  -a, --auto-approve   Auto-approve all files (skip manual review)
  -o, --output <dir>    Output directory for git repo (default: ./reconstructed-repos)
  -h, --help           Show this help message

Examples:
  # Interactive selection and manual approval
  node reconstruct.js

  # Specific repo with manual approval
  node reconstruct.js Adrian

  # Auto-approve all files for fast reconstruction
  node reconstruct.js Adrian --auto-approve

  # With custom output directory
  node reconstruct.js Adrian -a -o ./my-reconstructed-repos

Workflow:
  1. Select a repository from the Repos/ directory
  2. Choose approval mode (auto or manual)
  3. Review and approve files (if manual)
  4. Create git repository with original dates preserved

Note:
  - Files with similar names (index.htmla, index.htmle, etc.) are grouped together
  - NTFS 100-nanosecond timestamps are preserved
  - Original directory structure is maintained
`);
}

/**
 * Main function
 */
async function main() {
    const options = parseArguments();
    
    if (options.help) {
        showHelp();
        return;
    }
    
    displayHeader('GIT RECONSTRUCTOR');
    
    // Step 1: Select repository
    let repoName = options.repo;
    
    if (!repoName) {
        console.log(colors.blue + 'Available repositories in Repos/:' + colors.reset);
        const repos = await listAvailableRepos();
        
        if (repos.length === 0) {
            console.log(colors.yellow + 'No repositories found in Repos/ directory.' + colors.reset);
            process.exit(1);
        }
        
        repoName = await selectFromList('Select a repository to reconstruct:', repos, true);
        
        if (repoName === null) {
            console.log(colors.yellow + 'No repository selected. Goodbye!' + colors.reset);
            process.exit(0);
        }
        
        if (repoName === 'CUSTOM') {
            const readline = require('readline');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            
            const question = colors.bold + '\nEnter custom directory path (relative to project root): ' + colors.reset;
            process.stdout.write(question);
            
            repoName = await new Promise((resolve) => {
                rl.on('line', (input) => {
                    rl.close();
                    resolve(input.trim());
                });
            });
            
            if (!repoName) {
                console.log(colors.yellow + 'No directory specified. Goodbye!' + colors.reset);
                process.exit(0);
            }
        }
    }
    
    // Step 2: Select approval mode
    let autoApprove = options.autoApprove;
    
    if (autoApprove === undefined) {
        autoApprove = await askYesNo('Auto-approve all files (skip manual review)?');
    }
    
    // Step 3: Set output directory
    const outputDir = options.outputDir || './reconstructed-repos';
    
    // Step 4: Run reconstruction
    try {
        await runReconstruction(repoName, autoApprove, outputDir);
        
        console.log(colors.green + '\n✓ Reconstruction complete!' + colors.reset);
        console.log(colors.blue + `\nYour reconstructed git repository is ready at: ./reconstructed-repos/${repoName}` + colors.reset);
        console.log(colors.blue + '\nYou can explore it with:' + colors.reset);
        console.log(colors.cyan + `  cd reconstructed-repos/${repoName} && git log --oneline` + colors.reset);
        console.log(colors.cyan + `  cd reconstructed-repos/${repoName} && git show` + colors.reset);
        
    } catch (error) {
        console.error(colors.red + `Error: ${error.message}` + colors.reset);
        process.exit(1);
    }
}

// Run the tool
main();

// Export for testing
module.exports = {
    listAvailableRepos,
    selectFromList,
    askYesNo,
    runReconstruction
};