#!/usr/bin/env node

/**
 * GitReconstructor - Censorship Update Script
 * 
 * Updates an existing reconstructed repository with the latest censorship rules.
 * This allows reapplying censorship without rebuilding the entire repo.
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const execAsync = promisify(exec);
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
 * Escape regex special characters
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Apply censorship to file content by replacing blacklisted strings
 */
function applyCensorship(content, blacklist) {
    if (!blacklist || !Array.isArray(blacklist) || blacklist.length === 0) {
        return content;
    }
    
    let result = content;
    for (const blacklistedString of blacklist) {
        if (typeof blacklistedString === 'string' && blacklistedString.length > 0) {
            const replacement = '*'.repeat(blacklistedString.length);
            result = result.replace(new RegExp(escapeRegExp(blacklistedString), 'g'), replacement);
        }
    }
    return result;
}

/**
 * Load blacklist from JSON file
 */
async function loadBlacklist() {
    const blacklistPath = path.join(process.cwd(), 'blacklist.json');
    try {
        const data = await fs.promises.readFile(blacklistPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        logWarn(`No blacklist.json found: ${error.message}`);
        return [];
    }
}

/**
 * Check if file is likely text-based (not binary)
 */
function isTextFile(filePath, buffer) {
    // Check file extension
    const ext = path.extname(filePath).toLowerCase();
    const textExtensions = ['.html', '.htm', '.js', '.json', '.css', '.txt', '.md', '.xml', '.svg'];
    
    if (textExtensions.includes(ext)) {
        return true;
    }
    
    // Check for null bytes (indicative of binary)
    if (buffer && buffer.includes('\0')) {
        return false;
    }
    
    // If we have content and it doesn't look like binary, treat as text
    return true;
}

/**
 * Get all text files in a directory recursively
 */
async function getTextFiles(dir, blacklist) {
    const files = [];
    
    const items = await readdir(dir, { withFileTypes: true });
    
    for (const item of items) {
        const fullPath = path.join(dir, item.name);
        
        if (item.isDirectory()) {
            // Skip .git directory
            if (item.name === '.git') {
                continue;
            }
            const subFiles = await getTextFiles(fullPath, blacklist);
            files.push(...subFiles);
        } else if (item.isFile()) {
            // Only include files that might need censorship
            const ext = path.extname(item.name).toLowerCase();
            const textExtensions = ['.html', '.htm', '.js', '.json', '.css', '.txt', '.md', '.xml', '.svg', '.php', '.py', '.rb', '.java', '.c', '.h', '.cpp', '.hpp'];
            
            if (textExtensions.includes(ext) || ext === '') {
                files.push(fullPath);
            }
        }
    }
    
    return files;
}

/**
 * Update a single file with censorship
 */
async function updateFile(filePath, blacklist) {
    try {
        // Read the file
        const content = await fs.promises.readFile(filePath, 'utf8');
        
        // Apply censorship
        const censoredContent = applyCensorship(content, blacklist);
        
        // Only write if content changed
        if (content !== censoredContent) {
            await writeFile(filePath, censoredContent);
            return true; // File was updated
        }
        return false; // No changes
    } catch (error) {
        // If reading as UTF-8 fails, it might be binary or use different encoding
        logWarn(`Could not read/process ${filePath}: ${error.message}`);
        return false;
    }
}

/**
 * Update an existing git repository with latest censorship
 */
async function updateRepositoryWithCensorship(repoPath, blacklist) {
    logInfo(`Scanning repository: ${repoPath}`);
    
    // Get all text files in the repository (excluding .git)
    const textFiles = await getTextFiles(repoPath, blacklist);
    logInfo(`Found ${textFiles.length} text files to check`);
    
    let updatedCount = 0;
    const updatedFiles = [];
    
    // Process each file
    for (const filePath of textFiles) {
        const relativePath = path.relative(repoPath, filePath);
        const result = await updateFile(filePath, blacklist);
        
        if (result) {
            updatedCount++;
            updatedFiles.push(relativePath);
            logSuccess(`Updated: ${relativePath}`);
        }
    }
    
    if (updatedCount === 0) {
        logInfo('No files needed censorship updates');
        return false;
    }
    
    // Commit the changes
    try {
        // Stage all changes
        for (const relativePath of updatedFiles) {
            const escapedPath = `"${relativePath}"`;
            await execAsync(`git add ${escapedPath}`, { 
                cwd: repoPath,
                shell: true 
            });
        }
        
        // Create commit
        const commitMessage = `Censorship update: ${updatedCount} files updated`;
        const escapedMessage = commitMessage.replace(/"/g, '\\"');
        
        await execAsync(`git commit -m "${escapedMessage}"`, { 
            cwd: repoPath,
            shell: true 
        });
        
        logSuccess(`Committed censorship updates: ${updatedCount} files`);
        return true;
        
    } catch (error) {
        logError(`Failed to commit censorship updates: ${error.message}`);
        return false;
    }
}

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = { 
        repoPath: null, 
        blacklist: null,
        help: false 
    };
    
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg.startsWith('--')) { 
            console.error(`Unknown option: ${arg}`); 
            process.exit(1); 
        }
        else if (options.repoPath === null) options.repoPath = arg;
        else { 
            console.error(`Unexpected argument: ${arg}`); 
            process.exit(1); 
        }
        i++;
    }
    return options;
}

/**
 * Show help
 */
function showHelp() {
    console.log(`
GitReconstructor Censorship Update

Usage:
  node update_censorship.js <repo-path>    # Update specified repository
  node update_censorship.js                # Update default reconstructed repo
  node update_censorship.js -h             # Show this help

Arguments:
  <repo-path>   Path to reconstructed repository (default: ./reconstructed-repos/Adrian)

Description:
  Updates an existing reconstructed repository with the latest censorship rules
  from blacklist.json. Creates a new commit with any censored changes.

Workflow:
  1. Loads blacklist.json from current directory
  2. Scans all text files in the repository
  3. Applies censorship to files containing blacklisted strings
  4. Creates a git commit with the changes
`);
}

/**
 * Main function
 */
async function main() {
    const options = parseArgs();
    
    if (options.help) {
        showHelp();
        return;
    }
    
    logHeader('CENSORSHIP UPDATE');
    
    // Default repo path
    const defaultRepoPath = path.join(process.cwd(), 'reconstructed-repos', 'Adrian');
    const repoPath = options.repoPath || defaultRepoPath;
    
    // Check if repo exists
    try {
        await fs.promises.access(repoPath, fs.constants.F_OK);
    } catch (error) {
        logError(`Repository not found: ${repoPath}`);
        process.exit(1);
    }
    
    // Check if it's a git repo
    try {
        await fs.promises.access(path.join(repoPath, '.git'), fs.constants.F_OK);
    } catch (error) {
        logError(`Not a git repository: ${repoPath}`);
        process.exit(1);
    }
    
    // Load blacklist
    const blacklist = await loadBlacklist();
    if (blacklist.length === 0) {
        logWarn('No blacklist entries found. Create a blacklist.json file with strings to censor.');
        process.exit(0);
    }
    
    logInfo(`Loaded ${blacklist.length} blacklisted strings`);
    
    // Update repository
    try {
        const updated = await updateRepositoryWithCensorship(repoPath, blacklist);
        
        if (updated) {
            logHeader('CENSORSHIP UPDATE COMPLETE');
            logSuccess(`Updated repository: ${repoPath}`);
            logInfo('View changes:');
            console.log(colors.cyan + `  cd "${repoPath}" && git log --oneline -1` + colors.reset);
            console.log(colors.cyan + `  cd "${repoPath}" && git diff HEAD~1` + colors.reset);
        } else {
            logInfo('No censorship updates needed');
        }
        
    } catch (error) {
        logError(`Censorship update failed: ${error.message}`);
        process.exit(1);
    }
}

// Run
main().catch(error => {
    logError(`Fatal error: ${error.message}`);
    process.exit(1);
});