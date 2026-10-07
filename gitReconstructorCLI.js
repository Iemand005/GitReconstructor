#!/usr/bin/env node

/**
 * GitReconstructor CLI - Interactive Git Repository Reconstruction
 * 
 * Walks through reconstructed history, lets you approve/deny files,
 * then creates a real git repository with the approved files and their original dates.
 * 
 * Usage:
 *   node gitReconstructorCLI.js <reconstructed-json> [options]
 * 
 * Example:
 *   node gitReconstructorCLI.js adrian-commits.json
 *   node gitReconstructorCLI.js adrian-commits.json --auto-approve
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { exec, spawn } = require('child_process');
const { promisify: p } = require('util');

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const exists = promisify(fs.exists);
const copyFile = promisify(fs.copyFile);
const stat = promisify(fs.stat);
const execAsync = p(exec);

// NTFS FILETIME to Unix timestamp conversion
const NTFS_EPOCH = new Date('1601-01-01T00:00:00.000Z');
const UNIX_EPOCH = new Date('1970-01-01T00:00:00.000Z');
const FILETIME_PER_SECOND = 10000000n; // 100-nanosecond intervals per second
const FILETIME_PER_MS = 10000n; // 100-nanosecond intervals per millisecond
const EPOCH_DIFF_MS = UNIX_EPOCH - NTFS_EPOCH;

/**
 * Convert NTFS FILETIME to JavaScript Date
 * @param {string|number|BigInt} filetime - NTFS FILETIME value
 * @returns {Date} - JavaScript Date object
 */
function filetimeToDate(filetime) {
    // Ensure filetime is a string and convert to BigInt
    const filetimeStr = String(filetime);
    const filetimeBig = BigInt(filetimeStr);
    
    // NTFS EPOCH (1601-01-01) to UNIX EPOCH (1970-01-01) difference in 100-nanosecond intervals
    const EPOCH_DIFF_FILETIME = 116444736000000000n; // 132824454400000000 for 1970-01-01
    
    // Convert FILETIME to Unix timestamp in milliseconds
    // FILETIME: 100-nanosecond intervals since 1601-01-01
    // Unix: milliseconds since 1970-01-01
    const unixTimestampMs = Number((filetimeBig - EPOCH_DIFF_FILETIME) / 10000n);
    return new Date(unixTimestampMs);
}

/**
 * Convert NTFS FILETIME to Unix timestamp for git (seconds since 1970)
 * @param {string} filetime - NTFS FILETIME value
 * @returns {string} - Unix timestamp in format for git
 */
function filetimeToGitDate(filetime) {
    const date = filetimeToDate(filetime);
    // Format for git: "Mon DD YYYY HH:MM:SS +ZZZZ"
    const pad = (n) => n.toString().padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const year = date.getFullYear();
    const month = months[date.getMonth()];
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    
    // Get timezone offset
    const offset = date.getTimezoneOffset();
    const offsetHours = Math.floor(Math.abs(offset) / 60).toString().padStart(2, '0');
    const offsetMinutes = (Math.abs(offset) % 60).toString().padStart(2, '0');
    const offsetSign = offset < 0 ? '+' : '-';
    
    return `${month} ${day} ${year} ${hours}:${minutes}:${seconds} ${offsetSign}${offsetHours}${offsetMinutes}`;
}

/**
 * Escape path for Windows command line
 */
function escapePath(p) {
    // Replace backslashes with forward slashes and quote the path
    return `"${p.replace(/\\/g, '/')}"`;
}

/**
 * Parse command line arguments
 */
function parseArguments() {
    const args = process.argv.slice(2);
    const options = {
        jsonPath: null,
        outputDir: null,
        autoApprove: false,
        help: false
    };
    
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        
        if (arg === '--output' || arg === '-o') {
            options.outputDir = args[++i];
            i++;
        } else if (arg === '--auto-approve' || arg === '-a' || arg === '--all') {
            options.autoApprove = true;
            i++;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg.startsWith('--')) {
            console.error(`Unknown option: ${arg}`);
            process.exit(1);
        } else {
            if (options.jsonPath === null) {
                options.jsonPath = arg;
            } else if (options.outputDir === null) {
                options.outputDir = arg;
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
GitReconstructor CLI - Interactive Git Repository Reconstruction

Usage:
  node gitReconstructorCLI.js <reconstructed-json> [options]

Arguments:
  <reconstructed-json>   JSON file from gitReconstructor.js (e.g., adrian-commits.json)

Options:
  -a, --auto-approve     Auto-approve all files (for fast iteration)
  -o, --output <dir>    Output directory for the git repo (default: ./reconstructed-repos)
  -h, --help            Show this help message

Examples:
  # Interactive mode
  node gitReconstructorCLI.js adrian-commits.json

  # Auto-approve all files (fast mode)
  node gitReconstructorCLI.js adrian-commits.json --auto-approve

  # Auto-approve to specific directory
  node gitReconstructorCLI.js adrian-commits.json --auto-approve -o ./Adrian-reconstructed

How it works:
  1. Loads the reconstructed commit history from JSON
  2. Shows files chronologically (oldest first)
  3. For each file: Approve, Deny, or Quit (or auto-approve all)
  4. After reviewing all files: Shows overview of approved files
  5. Choose: Commit to git repo or Edit selections
  6. If committed: Creates real git repo with files and their original dates

Git date injection:
  - Uses filetime (NTFS 100ns precision) to set original modification dates
  - Creates files with their exact timestamps from the reconstruction
  - Files are grouped into commits based on timestamp proximity
`);
}

// ANSI color codes for CLI
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
 * Display file information
 */
function displayFileInfo(file, index, total) {
    console.log(colors.bold + `\n[${index + 1}/${total}]` + colors.reset);
    console.log(colors.yellow + `Original: ` + colors.white + `${file.originalFilename}` + colors.reset);
    console.log(colors.blue + `Path: ` + colors.white + `${file.path}` + colors.reset);
    console.log(colors.blue + `Filename: ` + colors.white + `${file.filename}` + colors.reset);
    console.log(colors.blue + `Date: ` + colors.white + `${file.date}` + colors.reset);
    console.log(colors.blue + `Filetime: ` + colors.white + `${file.filetime}` + colors.reset);
    if (file.isPrimary) {
        console.log(colors.green + `✓ Primary file` + colors.reset);
    }
    if (file.versionIndex > 1) {
        console.log(colors.dim + `Version ${file.versionIndex} of ${file.totalVersions}` + colors.reset);
    }
}

/**
 * Display overview of approved files
 */
function displayApprovedOverview(approvedFiles) {
    displayHeader('APPROVED FILES OVERVIEW');
    
    if (approvedFiles.length === 0) {
        console.log(colors.yellow + 'No files approved yet.' + colors.reset);
        return;
    }
    
    console.log(colors.bold + `\nTotal approved: ${approvedFiles.length} files` + colors.reset);
    console.log(colors.bold + 'Files to be added to git repository:' + colors.reset);
    
    approvedFiles.forEach((file, index) => {
        console.log(`\n${index + 1}. ${colors.green}${file.filename}${colors.reset}`);
        console.log(`   Path: ${file.path}`);
        console.log(`   Date: ${file.date}`);
        console.log(`   Filetime: ${file.filetime}`);
    });
    
    console.log('\n' + '-'.repeat(60));
}

/**
 * Create a readline interface (singleton)
 */
let readlineInterface = null;
function getReadlineInterface() {
    if (!readlineInterface) {
        const readline = require('readline');
        readlineInterface = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }
    return readlineInterface;
}

/**
 * Ask for user input with options
 */
async function askQuestion(question, options) {
    return new Promise((resolve) => {
        process.stdout.write(colors.bold + `\n${question} ` + colors.reset);
        
        // Show options
        const optionKeys = Object.keys(options);
        const optionDisplay = optionKeys.map(k => k.toUpperCase()).join('/');
        process.stdout.write(`[${optionDisplay}] `);
        
        const rl = getReadlineInterface();
        
        const listener = (input) => {
            const normalizedInput = input.trim().toLowerCase();
            
            // Handle empty input - default to first option
            if (!normalizedInput) {
                resolve({ choice: optionKeys[0], value: options[optionKeys[0]] });
                return;
            }
            
            // Check for exact match
            for (const [key, value] of Object.entries(options)) {
                if (normalizedInput === key.toLowerCase() || 
                    normalizedInput === key.toUpperCase() ||
                    normalizedInput === value.toLowerCase() ||
                    normalizedInput === value.toUpperCase()) {
                    resolve({ choice: key, value: value });
                    return;
                }
            }
            
            // Try single character match
            if (normalizedInput.length === 1) {
                for (const [key, value] of Object.entries(options)) {
                    if (key.toLowerCase().startsWith(normalizedInput) ||
                        key.toUpperCase().startsWith(normalizedInput.toUpperCase())) {
                        resolve({ choice: key, value: value });
                        return;
                    }
                }
            }
            
            // Default to first option if no match
            resolve({ choice: optionKeys[0], value: options[optionKeys[0]] });
        };
        
        rl.on('line', listener);
        
        // Handle the case where we need to remove the listener after getting the answer
        const cleanup = () => {
            rl.off('line', listener);
        };
        
        // Resolve the promise and cleanup
        const originalResolve = resolve;
        resolve = (value) => {
            cleanup();
            originalResolve(value);
        };
    });
}

/**
 * Ask to approve a file
 */
async function askToApproveFile() {
    const options = {
        a: 'Approve',
        d: 'Deny',
        q: 'Quit'
    };
    
    const result = await askQuestion('Approve this file?', options);
    return result.choice; // 'a', 'd', or 'q'
}

/**
 * Ask to commit or edit
 */
async function askCommitOrEdit() {
    const options = {
        c: 'Commit',
        e: 'Edit',
        q: 'Quit'
    };
    
    const result = await askQuestion('Commit approved files to git repository?', options);
    return result.choice; // 'c', 'e', or 'q'
}

/**
 * Load and prepare files from reconstructed JSON
 */
async function loadReconstructedFiles(jsonPath) {
    try {
        const content = await readFile(jsonPath, 'utf8');
        const data = JSON.parse(content);
        
        if (data.commits) {
            // Git-like format: extract all files from all commits
            const allFiles = [];
            for (const commit of data.commits) {
                for (const file of commit.files) {
                    allFiles.push(file);
                }
            }
            
            // Sort by date (oldest first)
            allFiles.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
            
            return { files: allFiles, metadata: data.metadata };
        } else {
            // History format: extract all files and their versions
            const allFiles = [];
            for (const entry of data) {
                // Add primary file
                allFiles.push({
                    ...entry,
                    isPrimary: true,
                    versionIndex: 0,
                    totalVersions: entry.versions.length + 1
                });
                
                // Add versions
                for (const version of entry.versions) {
                    allFiles.push({
                        originalFilename: entry.originalFilename,
                        ...version,
                        isPrimary: false,
                        versionIndex: entry.versions.indexOf(version) + 1,
                        totalVersions: entry.versions.length + 1
                    });
                }
            }
            
            // Sort by date (oldest first)
            allFiles.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
            
            return { files: allFiles, metadata: data.metadata || {} };
        }
    } catch (error) {
        throw new Error(`Error loading JSON: ${error.message}`);
    }
}

/**
 * Create git repository in output directory
 */
async function createGitRepo(outputDir, repoName) {
    const gitRepoPath = path.join(outputDir, repoName);
    
    try {
        // Check if directory exists
        const repoExists = await exists(gitRepoPath);
        
        if (repoExists) {
            console.log(colors.yellow + `Directory ${gitRepoPath} already exists` + colors.reset);
            return gitRepoPath;
        }
        
        // Create directory
        await mkdir(gitRepoPath, { recursive: true });
        
        // Initialize git repo
        await execAsync('git init', { cwd: gitRepoPath });
        console.log(colors.green + `✓ Git repository created at: ${gitRepoPath}` + colors.reset);
        
        return gitRepoPath;
    } catch (error) {
        throw new Error(`Error creating git repo: ${error.message}`);
    }
}

/**
 * Add a file to git repo with specific date
 */
async function addFileToGitRepo(gitRepoPath, file, sourceFilePath) {
    try {
        const targetPath = path.join(gitRepoPath, file.filename);
        
        // Ensure directory structure exists
        const dir = path.dirname(targetPath);
        if (dir !== gitRepoPath) {
            await mkdir(dir, { recursive: true });
        }
        
        // Copy the file from source using Node.js built-in copyFile
        if (sourceFilePath && await exists(sourceFilePath)) {
            await copyFile(sourceFilePath, targetPath);
        } else {
            // Create empty file if source doesn't exist
            await writeFile(targetPath, '');
        }
        
        // Set the modification time to the original filetime using Node.js
        const date = filetimeToDate(file.filetime);
        
        try {
            // Use utimes to set modification time
            await stat(targetPath); // Ensure file exists
            const atime = date.getTime() / 1000;
            const mtime = date.getTime() / 1000;
            
            // Use Windows-specific approach
            const { utimesSync } = require('fs');
            utimesSync(targetPath, atime, mtime);
            console.log(colors.green + `✓ Set date for ${file.filename} to ${file.date}` + colors.reset);
        } catch (touchError) {
            console.log(colors.yellow + `Warning: Could not set exact date for ${file.filename}: ${touchError.message}` + colors.reset);
        }
        
        // Add file to git
        await execAsync('git add .', { cwd: gitRepoPath });
        
        return true;
    } catch (error) {
        console.error(colors.red + `Error adding file ${file.filename}: ${error.message}` + colors.reset);
        return false;
    }
}

/**
 * Commit files to git with specific date
 */
async function commitToGitRepo(gitRepoPath, commitDate, commitMessage) {
    try {
        // Set git author and committer dates
        const gitDate = filetimeToGitDate(commitDate);
        
        // Configure git user (use generic for reconstruction)
        await execAsync('git config user.name "GitReconstructor"', { cwd: gitRepoPath });
        await execAsync('git config user.email "reconstructor@example.com"', { cwd: gitRepoPath });
        
        // Use GIT_AUTHOR_DATE and GIT_COMMITTER_DATE environment variables
        // This is the proper way to set commit dates in git
        const env = {
            ...process.env,
            GIT_AUTHOR_DATE: gitDate,
            GIT_COMMITTER_DATE: gitDate
        };
        
        // Escape the commit message properly for command line
        const escapedMessage = commitMessage.replace(/"/g, '\\"');
        
        // Use a simple approach: pass everything through shell with proper quoting
        const commitCmd = `git commit -m "${escapedMessage}"`;
        
        await execAsync(commitCmd, { 
            cwd: gitRepoPath,
            env: env,
            shell: true
        });
        
        console.log(colors.green + `✓ Committed with date: ${commitDate}` + colors.reset);
        return true;
    } catch (error) {
        console.error(colors.red + `Error committing to git: ${error.message}` + colors.reset);
        // Try to show what went wrong
        if (error.stdout) console.error('Git output:', error.stdout);
        if (error.stderr) console.error('Git error:', error.stderr);
        return false;
    }
}

/**
 * Auto-approve workflow (no interaction)
 */
async function mainAutoApprove(jsonPath, outputDir) {
    try {
        console.log(colors.blue + `Loading reconstructed data from ${jsonPath}...` + colors.reset);
        const { files, metadata } = await loadReconstructedFiles(jsonPath);
        
        if (files.length === 0) {
            console.log(colors.yellow + 'No files found in the reconstructed data.' + colors.reset);
            return;
        }
        
        displayHeader('GIT RECONSTRUCTION - AUTO-APPROVE MODE');
        console.log(colors.blue + `Auto-approving all ${files.length} files from ${metadata.fileCount || 'unknown'} original files` + colors.reset);
        
        // Auto-approve all files
        const approvedFiles = [...files];
        
        // Show overview
        displayApprovedOverview(approvedFiles);
        
        // Proceed directly to commit
        displayHeader('CREATING GIT REPOSITORY');
        
        // Determine output directory
        const finalOutputDir = outputDir || './reconstructed-repos';
        
        // Create output directory if it doesn't exist
        await mkdir(finalOutputDir, { recursive: true });
        
        // Use the same name as the original repo (from the JSON path)
        const jsonBasename = path.basename(jsonPath, '.json');
        const repoNameMatch = jsonBasename.match(/^(.+)-commits$|^(.+)-history$/);
        const repoName = repoNameMatch ? (repoNameMatch[1] || repoNameMatch[2]) : 'reconstructed';
        
        console.log(colors.blue + `Creating git repo: ${repoName}` + colors.reset);
        
        // Create git repository
        const gitRepoPath = await createGitRepo(finalOutputDir, repoName);
        
        // Group files by commit (based on filetime proximity)
        const groupedFiles = [];
        let currentGroup = [];
        let lastTimestamp = null;
        
        // Sort approved files by date
        approvedFiles.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        
        for (const file of approvedFiles) {
            const currentTimestamp = new Date(file.date).getTime();
            
            if (currentGroup.length === 0) {
                currentGroup.push(file);
                lastTimestamp = currentTimestamp;
            } else if (currentTimestamp - lastTimestamp <= 60000) {
                // Within 60 seconds, group in same commit
                currentGroup.push(file);
                lastTimestamp = currentTimestamp;
            } else {
                groupedFiles.push(currentGroup);
                currentGroup = [file];
                lastTimestamp = currentTimestamp;
            }
        }
        
        if (currentGroup.length > 0) {
            groupedFiles.push(currentGroup);
        }
        
        console.log(colors.blue + `Creating ${groupedFiles.length} commits...` + colors.reset);
        
        // Process each group as a commit
        for (let i = 0; i < groupedFiles.length; i++) {
            const group = groupedFiles[i];
            const commitDate = group[0].date; // Use first file's date as commit date
            const commitFiletime = group[0].filetime;
            
            console.log(colors.cyan + `\nCommit ${i + 1}/${groupedFiles.length}: ${commitDate}` + colors.reset);
            
            // Add all files in this group
            for (const file of group) {
                // Find the source file in the original repos directory
                const sourcePath = path.resolve(path.join(process.cwd(), file.path));
                const success = await addFileToGitRepo(gitRepoPath, file, sourcePath);
                
                if (success) {
                    console.log(colors.green + `  ✓ Added: ${file.filename} (${file.date})` + colors.reset);
                } else {
                    console.log(colors.red + `  ✗ Failed: ${file.filename}` + colors.reset);
                }
            }
            
            // Commit this group
            const commitMessage = `Reconstructed commit ${i + 1} - ${new Date(commitDate).toLocaleDateString()}`;
            const success = await commitToGitRepo(gitRepoPath, commitFiletime, commitMessage);
            
            if (success) {
                console.log(colors.green + `  ✓ Commit created: ${commitMessage}` + colors.reset);
            } else {
                console.log(colors.red + `  ✗ Commit failed` + colors.reset);
            }
        }
        
        console.log(colors.green + '\n✓ Git repository reconstruction complete!' + colors.reset);
        console.log(colors.blue + `Repository location: ${gitRepoPath}` + colors.reset);
        console.log(colors.blue + 'You can now explore the reconstructed git repository with:' + colors.reset);
        console.log(colors.cyan + `  cd "${gitRepoPath}" && git log --oneline` + colors.reset);
        console.log(colors.cyan + `  cd "${gitRepoPath}" && git show` + colors.reset);
        
    } catch (error) {
        console.error(colors.red + `Error: ${error.message}` + colors.reset);
        process.exit(1);
    }
}

/**
 * Main interactive workflow
 */
async function mainInteractive(jsonPath, outputDir) {
    try {
        // Load reconstructed files
        console.log(colors.blue + `Loading reconstructed data from ${jsonPath}...` + colors.reset);
        const { files, metadata } = await loadReconstructedFiles(jsonPath);
        
        if (files.length === 0) {
            console.log(colors.yellow + 'No files found in the reconstructed data.' + colors.reset);
            return;
        }
        
        displayHeader('GIT RECONSTRUCTION - INTERACTIVE MODE');
        console.log(colors.blue + `Found ${files.length} files from ${metadata.fileCount || 'unknown'} original files` + colors.reset);
        console.log(colors.blue + `Sorted chronologically (oldest first)` + colors.reset);
        
        // Phase 1: Approve/Deny files
        const approvedFiles = [];
        let shouldQuit = false;
        
        for (let i = 0; i < files.length && !shouldQuit; i++) {
            const file = files[i];
            
            displayFileInfo(file, i, files.length);
            
            const choice = await askToApproveFile();
            
            switch (choice) {
                case 'a':
                    approvedFiles.push(file);
                    console.log(colors.green + '✓ File approved' + colors.reset);
                    break;
                case 'd':
                    console.log(colors.red + '✗ File denied' + colors.reset);
                    break;
                case 'q':
                    shouldQuit = true;
                    console.log(colors.yellow + 'Quit requested' + colors.reset);
                    break;
            }
        }
        
        if (approvedFiles.length === 0) {
            console.log(colors.yellow + 'No files were approved. Nothing to commit.' + colors.reset);
            return;
        }
        
        // Phase 2: Show overview and ask to commit or edit
        displayApprovedOverview(approvedFiles);
        
        const action = await askCommitOrEdit();
        
        switch (action) {
            case 'q':
                console.log(colors.yellow + 'Quit requested. Goodbye!' + colors.reset);
                return;
                
            case 'e':
                console.log(colors.yellow + 'Edit mode: Restarting approval process...' + colors.reset);
                await mainInteractive(jsonPath, outputDir);
                return;
                
            case 'c':
                // Commit phase
                displayHeader('CREATING GIT REPOSITORY');
                
                // Determine output directory
                const finalOutputDir = outputDir || './reconstructed-repos';
                
                // Create output directory if it doesn't exist
                await mkdir(finalOutputDir, { recursive: true });
                
                // Use the same name as the original repo (from the JSON path)
                const jsonBasename = path.basename(jsonPath, '.json');
                const repoNameMatch = jsonBasename.match(/^(.+)-commits$|^(.+)-history$/);
                const repoName = repoNameMatch ? (repoNameMatch[1] || repoNameMatch[2]) : 'reconstructed';
                
                console.log(colors.blue + `Creating git repo: ${repoName}` + colors.reset);
                
                // Create git repository
                const gitRepoPath = await createGitRepo(finalOutputDir, repoName);
                
                // Group files by commit (based on filetime proximity)
                const groupedFiles = [];
                let currentGroup = [];
                let lastTimestamp = null;
                
                // Sort approved files by date
                approvedFiles.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
                
                for (const file of approvedFiles) {
                    const currentTimestamp = new Date(file.date).getTime();
                    
                    if (currentGroup.length === 0) {
                        currentGroup.push(file);
                        lastTimestamp = currentTimestamp;
                    } else if (currentTimestamp - lastTimestamp <= 60000) {
                        // Within 60 seconds, group in same commit
                        currentGroup.push(file);
                        lastTimestamp = currentTimestamp;
                    } else {
                        groupedFiles.push(currentGroup);
                        currentGroup = [file];
                        lastTimestamp = currentTimestamp;
                    }
                }
                
                if (currentGroup.length > 0) {
                    groupedFiles.push(currentGroup);
                }
                
                console.log(colors.blue + `Creating ${groupedFiles.length} commits...` + colors.reset);
                
                // Process each group as a commit
                for (let i = 0; i < groupedFiles.length; i++) {
                    const group = groupedFiles[i];
                    const commitDate = group[0].date; // Use first file's date as commit date
                    const commitFiletime = group[0].filetime;
                    
                    console.log(colors.cyan + `\nCommit ${i + 1}/${groupedFiles.length}: ${commitDate}` + colors.reset);
                    
                    // Add all files in this group
                    for (const file of group) {
                        // Find the source file in the original repos directory
                        const sourcePath = path.resolve(path.join(process.cwd(), file.path));
                        const success = await addFileToGitRepo(gitRepoPath, file, sourcePath);
                        
                        if (success) {
                            console.log(colors.green + `  ✓ Added: ${file.filename} (${file.date})` + colors.reset);
                        } else {
                            console.log(colors.red + `  ✗ Failed: ${file.filename}` + colors.reset);
                        }
                    }
                    
                    // Commit this group
                    const commitMessage = `Reconstructed commit ${i + 1} - ${new Date(commitDate).toLocaleDateString()}`;
                    const success = await commitToGitRepo(gitRepoPath, commitFiletime, commitMessage);
                    
                    if (success) {
                        console.log(colors.green + `  ✓ Commit created: ${commitMessage}` + colors.reset);
                    } else {
                        console.log(colors.red + `  ✗ Commit failed` + colors.reset);
                    }
                }
                
                console.log(colors.green + '\n✓ Git repository reconstruction complete!' + colors.reset);
                console.log(colors.blue + `Repository location: ${gitRepoPath}` + colors.reset);
                console.log(colors.blue + 'You can now explore the reconstructed git repository with:' + colors.reset);
                console.log(colors.cyan + `  cd "${gitRepoPath}" && git log --oneline` + colors.reset);
                console.log(colors.cyan + `  cd "${gitRepoPath}" && git show` + colors.reset);
                
                break;
        }
        
    } catch (error) {
        console.error(colors.red + `Error: ${error.message}` + colors.reset);
        process.exit(1);
    }
}

/**
 * Main function
 */
async function main() {
    const options = parseArguments();
    
    if (options.help || !options.jsonPath) {
        showHelp();
        return;
    }
    
    try {
        // Check if JSON file exists
        const jsonExists = await exists(options.jsonPath);
        if (!jsonExists) {
            console.error(colors.red + `Error: JSON file not found: ${options.jsonPath}` + colors.reset);
            process.exit(1);
        }
        
        // Choose workflow based on options
        if (options.autoApprove) {
            await mainAutoApprove(options.jsonPath, options.outputDir);
        } else {
            await mainInteractive(options.jsonPath, options.outputDir);
        }
        
    } catch (error) {
        console.error(colors.red + `Error: ${error.message}` + colors.reset);
        process.exit(1);
    }
}

// Run the tool
main();

// Export functions for use as a module
module.exports = {
    filetimeToDate,
    filetimeToGitDate,
    loadReconstructedFiles,
    createGitRepo,
    addFileToGitRepo,
    commitToGitRepo,
    mainAutoApprove
};