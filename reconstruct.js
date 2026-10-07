#!/usr/bin/env node

/**
 * GitReconstructor - Main Entry Point
 * 
 * Simple unified interface for reconstructing git repositories from file backups.
 * 
 * Usage:
 *   node reconstruct.js                    # Interactive mode
 *   node reconstruct.js <repo-name>       # Specific repo, asks auto/manual
 *   node reconstruct.js <repo-name> -a    # Auto-approve mode
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');
const readline = require('readline');

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const execAsync = promisify(exec);
const copyFile = promisify(fs.copyFile);
const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);

// ANSI colors
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m', 
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m'
};

function logHeader(title) {
    console.log(colors.cyan + '\n' + '='.repeat(60));
    console.log(title.padStart(30 + Math.floor(30/2)));
    console.log('='.repeat(60) + colors.reset);
}

function logInfo(msg) { console.log(colors.blue + msg + colors.reset); }
function logSuccess(msg) { console.log(colors.green + '✓ ' + msg + colors.reset); }
function logError(msg) { console.log(colors.red + '✗ ' + msg + colors.reset); }
function logWarn(msg) { console.log(colors.yellow + '⚠ ' + msg + colors.reset); }

/**
 * List available repositories in Repos directory
 */
async function listRepos() {
    const reposDir = path.join(process.cwd(), 'Repos');
    
    try {
        const items = await readdir(reposDir);
        return items.filter(item => 
            !item.startsWith('.') && 
            fs.statSync(path.join(reposDir, item)).isDirectory()
        );
    } catch (error) {
        logWarn(`No Repos directory found: ${error.message}`);
        return [];
    }
}

/**
 * Escape a path for shell commands (handle spaces)
 */
function escapePath(p) {
    // Double quotes for Windows cmd
    return `"${p}"`;
}

/**
 * Normalize filename to ensure variants are grouped together
 * This handles cases where gitReconstructor.js didn't properly group variants
 */
function normalizeFilenameForGit(originalFilename, actualFilename, filePath) {
    // For Adrian's specific case, we need to handle backup file patterns
    const parsed = path.parse(actualFilename);
    let baseName = parsed.name;
    
    // Handle directory-based filename normalization
    // If file is in a directory named "countdown", treat index.html as countdown.html
    if (filePath && filePath.includes(path.sep + 'countdown' + path.sep) && actualFilename === 'index.html') {
        return 'countdown.html';
    }
    
    // Handle index variants - files like index.htmla, index.htmle should become index.html
    if (baseName.match(/^index/)) {  
        // For index files, always use .html extension
        return 'index.html'; 
    }
    if (baseName.match(/^Birthday Counter/)) {
        // Normalize Birthday Counter files
        return 'Birthday Counter.html';
    }
    
    // Specific file mappings for Adrian's repo
    if (actualFilename === 'selfreliantmonstrousoutliner.adriankusmierek.repl.co.html') {
        return 'Birthday Counter.html';
    }
    
    // Default to original filename
    return originalFilename || actualFilename;
}

/**
 * Ask user to select from options
 */
async function selectOption(question, options) {
    return new Promise((resolve) => {
        console.log(colors.bold + '\n' + question + colors.reset);
        options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
        console.log(`  q. Quit`);
        
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const cleanup = () => rl.close();
        
        rl.on('line', (input) => {
            cleanup();
            const trimmed = input.trim().toLowerCase();
            if (trimmed === 'q') resolve(null);
            else {
                const index = parseInt(trimmed) - 1;
                resolve(index >= 0 && index < options.length ? options[index] : options[0]);
            }
        });
    });
}

/**
 * Ask yes/no
 */
async function askYesNo(question) {
    return new Promise((resolve) => {
        console.log(colors.bold + '\n' + question + ' ' + colors.reset + '[Y/n]');
        
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const cleanup = () => rl.close();
        
        rl.on('line', (input) => {
            cleanup();
            const trimmed = input.trim().toLowerCase();
            resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
        });
    });
}

/**
 * NTFS FILETIME to Date conversion
 */
function filetimeToDate(filetime) {
    const EPOCH_DIFF_FILETIME = 116444736000000000n; // 1601-01-01 to 1970-01-01 in 100ns intervals
    const filetimeBig = BigInt(filetime);
    const unixTimestampMs = Number((filetimeBig - EPOCH_DIFF_FILETIME) / 10000n);
    return new Date(unixTimestampMs);
}

/**
 * Convert date to git timestamp format
 */
function dateToGitTimestamp(date) {
    const pad = n => n.toString().padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const year = date.getFullYear();
    const month = months[date.getMonth()];
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    
    const offset = date.getTimezoneOffset();
    const offsetHours = Math.floor(Math.abs(offset) / 60).toString().padStart(2, '0');
    const offsetMinutes = (Math.abs(offset) % 60).toString().padStart(2, '0');
    const offsetSign = offset < 0 ? '+' : '-';
    
    return `${month} ${day} ${year} ${hours}:${minutes}:${seconds} ${offsetSign}${offsetHours}${offsetMinutes}`;
}

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = { repo: null, autoApprove: false, outputDir: './reconstructed-repos', help: false };
    
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg === '--auto-approve' || arg === '-a') options.autoApprove = true;
        else if (arg === '--output' || arg === '-o') options.outputDir = args[++i];
        else if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg.startsWith('--')) { console.error(`Unknown option: ${arg}`); process.exit(1); }
        else if (options.repo === null) options.repo = arg;
        else { console.error(`Unexpected argument: ${arg}`); process.exit(1); }
        i++;
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
  node reconstruct.js <repo-name>       # Specific repo
  node reconstruct.js <repo> -a         # Auto-approve all files

Options:
  <repo-name>          Name of repository in Repos/ directory
  -a, --auto-approve   Auto-approve all files (fast mode)
  -o, --output <dir>    Output directory (default: ./reconstructed-repos)
  -h, --help           Show this help message

Workflow:
  1. Select repository from Repos/ directory
  2. Choose auto-approve or manual review
  3. Create reconstruction JSON if needed
  4. Build git repository with preserved dates
`);
}

/**
 * Create reconstruction JSON
 */
async function createReconstructionJson(repoName) {
    const sourceDir = path.join(process.cwd(), 'Repos', repoName);
    const outputJson = path.join(process.cwd(), `${repoName}-commits.json`);
    
    logInfo(`Creating reconstruction JSON for ${repoName}...`);
    
    const { spawn } = require('child_process');
    const reconstructor = spawn('node', ['gitReconstructor.js', sourceDir, outputJson, '-f', 'git']);
    
    reconstructor.stdout.on('data', (data) => process.stdout.write(data));
    reconstructor.stderr.on('data', (data) => process.stderr.write(data));
    
    await new Promise((resolve, reject) => {
        reconstructor.on('close', (code) => {
            if (code === 0) {
                logSuccess(`Reconstruction JSON created: ${outputJson}`);
                resolve();
            } else {
                reject(new Error('Reconstruction failed'));
            }
        });
    });
    
    return outputJson;
}

/**
 * Load reconstructed data
 */
async function loadReconstructedData(jsonPath) {
    const data = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
    
    // Return the original commit structure
    return { 
        commits: data.commits || [],
        files: data.commits ? data.commits.flatMap(commit => commit.files || []) : [],
        metadata: data.metadata || {} 
    };
}

/**
 * Create git repository and add files
 */
async function createGitRepository(repoName, commits, files, outputDir, autoApprove = false) {
    const gitRepoPath = path.join(outputDir, repoName);
    
    // Create output directory
    await mkdir(gitRepoPath, { recursive: true });
    
    // Initialize git repo
    await execAsync('git init', { cwd: gitRepoPath });
    await execAsync('git config user.name "GitReconstructor"', { cwd: gitRepoPath });
    await execAsync('git config user.email "reconstructor@example.com"', { cwd: gitRepoPath });
    logSuccess(`Git repository initialized at: ${gitRepoPath}`);
    
    // Use the provided commits structure
    const commitsToProcess = commits.length > 0 ? commits : [];
    
    logInfo(`Creating ${commitsToProcess.length} commits...`);
    
    // Process each commit
    for (let commitIndex = 0; commitIndex < commitsToProcess.length; commitIndex++) {
        const commit = commitsToProcess[commitIndex];
        const group = commit.files || [commit]; // Handle both array and object formats
        const commitDate = commit.timestamp || group[0].date;
        const commitFiletime = commit.filetime || group[0].filetime;
        
        // Add all files in this commit
        for (const file of group) {
            try {
                // Resolve source path - replace backslashes and make absolute
                const normalizedPath = file.path.replace(/\\/g, path.sep);
                const fullSourcePath = path.resolve(process.cwd(), normalizedPath);
                
                // Use originalFilename for the target filename to get proper file history
                // Flatten directory structure - put all files in root of repo
                let targetFilename = normalizeFilenameForGit(file.originalFilename || file.filename, file.filename, file.path);
                const targetPath = path.join(gitRepoPath, targetFilename);
                
                // Copy the file
                if (fs.existsSync(fullSourcePath)) {
                    await copyFile(fullSourcePath, targetPath);
                    logSuccess(`Added: ${targetFilename} (${file.date})`);
                } else {
                    logWarn(`Source file not found: ${fullSourcePath} - creating empty file`);
                    await writeFile(targetPath, '');
                }
                
                // Set modification time
                try {
                    const date = filetimeToDate(file.filetime);
                    fs.utimesSync(targetPath, date, date);
                } catch (error) {
                    logWarn(`Could not set timestamp for ${targetFilename}: ${error.message}`);
                }
                
                // Add file to git staging area
                const escapedTargetPath = escapePath(targetFilename);
                await execAsync(`git add ${escapedTargetPath}`, { 
                    cwd: gitRepoPath,
                    shell: true 
                });
                
            } catch (error) {
                logError(`Failed to add ${file.filename}: ${error.message}`);
            }
        }
        
        // Commit this group
        try {
            const commitDateObj = new Date(commitDate);
            const gitDate = dateToGitTimestamp(commitDateObj);
            const commitMessage = `Reconstructed commit ${commitIndex + 1} - ${commitDateObj.toLocaleDateString()}`;
            
            const env = {
                ...process.env,
                GIT_AUTHOR_DATE: gitDate,
                GIT_COMMITTER_DATE: gitDate
            };
            
            const escapedMessage = commitMessage.replace(/"/g, '\\"');
            await execAsync(`git commit -m "${escapedMessage}"`, { 
                cwd: gitRepoPath,
                env: env,
                shell: true 
            });
            
            logSuccess(`Commit ${commitIndex + 1}/${commitsToProcess.length} created`);
        } catch (error) {
            logError(`Commit failed: ${error.message}`);
            // Continue to next commit
        }
    }
    
    return gitRepoPath;
}

/**
 * Main workflow
 */
async function main() {
    const options = parseArgs();
    
    if (options.help) {
        showHelp();
        return;
    }
    
    logHeader('GIT RECONSTRUCTOR');
    
    // Step 1: Select repository
    let repoName = options.repo;
    if (!repoName) {
        const repos = await listRepos();
        if (repos.length === 0) {
            logError('No repositories found in Repos/ directory.');
            process.exit(1);
        }
        
        repoName = await selectOption('Select repository to reconstruct:', repos);
        if (repoName === null) {
            logInfo('No repository selected. Goodbye!');
            process.exit(0);
        }
    }
    
    // Step 2: Select approval mode
    let autoApprove = options.autoApprove;
    if (!options.autoApprove) {
        autoApprove = await askYesNo('Auto-approve all files (skip manual review)?');
    }
    
    // Step 3: Check or create reconstruction JSON
    const jsonPath = path.join(process.cwd(), `${repoName}-commits.json`);
    let reconstructionData;
    
    try {
        reconstructionData = await loadReconstructedData(jsonPath);
        logSuccess(`Loaded existing reconstruction with ${reconstructionData.files.length} files in ${reconstructionData.commits.length} commits`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // Create reconstruction JSON
            await createReconstructionJson(repoName);
            reconstructionData = await loadReconstructedData(jsonPath);
            logSuccess(`Created and loaded reconstruction with ${reconstructionData.files.length} files in ${reconstructionData.commits.length} commits`);
        } else {
            throw error;
        }
    }
    
    if ((!reconstructionData.files || reconstructionData.files.length === 0) && 
        (!reconstructionData.commits || reconstructionData.commits.length === 0)) {
        logError('No files found in reconstruction data.');
        process.exit(1);
    }
    
    logInfo(`Processing ${reconstructionData.files.length} files in ${reconstructionData.commits.length} commits...`);
    
    // Step 4: Create git repository
    try {
        const gitRepoPath = await createGitRepository(repoName, reconstructionData.commits, reconstructionData.files, options.outputDir, autoApprove);
        
        logHeader('RECONSTRUCTION COMPLETE');
        logSuccess(`Git repository created: ${gitRepoPath}`);
        logInfo('View your reconstructed repository:');
        console.log(colors.cyan + `  cd "${gitRepoPath}" && git log --oneline` + colors.reset);
        console.log(colors.cyan + `  cd "${gitRepoPath}" && git show` + colors.reset);
        
    } catch (error) {
        logError(`Reconstruction failed: ${error.message}`);
        process.exit(1);
    }
}

// Run
main().catch(error => {
    logError(`Fatal error: ${error.message}`);
    process.exit(1);
});