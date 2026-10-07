#!/usr/bin/env node

/**
 * GitReconstructor - State-based Reconstruction
 * 
 * Reconstruct git repositories by treating different directories as different project states.
 * Transitions between states involve adding new files, modifying existing ones, and deleting files that don't exist in the new state.
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const execAsync = promisify(exec);
const copyFile = promisify(fs.copyFile);
const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);

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
 * Escape a path for shell commands (handle spaces)
 */
function escapePath(p) {
    return `"${p}"`;
}

/**
 * Normalize filename - remove variants like " - kopie", " - kopie (2)" etc.
 */
function normalizeFilename(filename) {
    // Remove common copy suffixes
    return filename
        .replace(/ - kopie \(\d+\)\.\w+$/, '.html')  // "file - kopie (2).html" -> "file.html"
        .replace(/ - kopie\.\w+$/, '.html')          // "file - kopie.html" -> "file.html"
        .replace(/\d+$/, '')                        // Remove trailing numbers
        .replace(/\.\w+$/, '.html');               // Ensure .html extension
}

/**
 * Extract directory from file path
 */
function getDirectory(filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
    if (parts.length <= 1) return '.';
    const dir = parts.slice(0, -1).join('/');
    
    // Clean up directory names for consistency
    return dir
        .replace(/^Repos\/Adrian\//, '')  // Remove Repos/Adrian prefix
        .replace(/\/$/, '')             // Remove trailing slash
        .replace(/^\//, '');            // Remove leading slash
}

/**
 * Get the base repository path from full path
 */
function getRelativePath(filePath, repoName) {
    const fullPath = path.resolve(process.cwd(), filePath.replace(/\\/g, path.sep));
    const repoBase = path.resolve(process.cwd(), 'Repos', repoName);
    
    if (fullPath.startsWith(repoBase)) {
        return fullPath.substring(repoBase.length + 1); // +1 to remove the separator
    }
    return filePath.replace(/\\/g, '/');
}

/**
 * Group files by state/directory and order by date
 */
function groupFilesByState(reconstructionData) {
    const states = {};
    
    reconstructionData.commits.forEach((commit, commitIndex) => {
        commit.files.forEach(file => {
            const fileDate = new Date(file.date || file.timestamp);
            const relativePath = getRelativePath(file.path, reconstructionData.metadata.repoName || 'Adrian');
            const dir = getDirectory(relativePath);
            const filename = path.basename(relativePath);
            
            if (!states[dir]) {
                states[dir] = {
                    files: {},
                    earliestDate: fileDate,
                    latestDate: fileDate,
                    commitIndex: commitIndex
                };
            }
            
            // Update dates
            if (fileDate < states[dir].earliestDate) states[dir].earliestDate = fileDate;
            if (fileDate > states[dir].latestDate) states[dir].latestDate = fileDate;
            
            // Store file info with the latest version for each filename
            if (!states[dir].files[filename] || fileDate > new Date(states[dir].files[filename].date)) {
                states[dir].files[filename] = {
                    ...file,
                    filename: filename,
                    relativePath: relativePath,
                    fullPath: path.resolve(process.cwd(), file.path.replace(/\\/g, path.sep)),
                    date: fileDate,
                    commitIndex: commitIndex
                };
            }
        });
    });
    
    return states;
}

/**
 * Order states by their earliest date
 */
function orderStatesByDate(states) {
    return Object.keys(states)
        .sort((a, b) => {
            // Final state (with commitIndex 999) should come last
            if (states[a].commitIndex === 999) return 1;
            if (states[b].commitIndex === 999) return -1;
            return states[a].earliestDate - states[b].earliestDate;
        })
        .map(dir => states[dir]);
}

/**
 * Get the final state (root directory) and clean it up
 */
function getFinalState(states) {
    const rootState = states['.'] || states['Repos/Adrian'];
    if (!rootState) return null;
    
    // Keep only index.html and the 4 png files
    const finalFiles = {};
    const allowedPngFiles = ['cake_inner.png', 'cake_bottom.png', 'cake_side.png', 'cake_top.png'];
    
    Object.keys(rootState.files).forEach(filename => {
        const baseName = path.parse(filename).name.toLowerCase();
        const normalizedFilename = normalizeFilename(filename);
        
        // Keep index.html (and normalize variants)
        if (baseName.includes('index') || normalizedFilename === 'index.html') {
            finalFiles['index.html'] = rootState.files[filename];
        }
        // Keep the 4 specific png files
        else if (allowedPngFiles.includes(filename.toLowerCase())) {
            finalFiles[filename] = rootState.files[filename];
        }
        // Skip renamed copies and other files
    });
    
    // Use the latest date from among the final files for ordering
    let latestDate = new Date(0);
    Object.keys(finalFiles).forEach(filename => {
        const fileDate = new Date(finalFiles[filename].date);
        if (fileDate > latestDate) {
            latestDate = fileDate;
        }
    });
    
    return {
        files: finalFiles,
        earliestDate: latestDate,
        latestDate: latestDate,
        commitIndex: 999 // High index to ensure it's processed last
    };
}

/**
 * Create git repository with state-based reconstruction
 */
async function createStateBasedGitRepository(repoName, reconstructionData, outputDir) {
    const gitRepoPath = path.join(outputDir, repoName);
    
    // Create output directory
    await mkdir(gitRepoPath, { recursive: true });
    
    // Initialize git repo
    await execAsync('git init', { cwd: gitRepoPath });
    await execAsync('git config user.name "GitReconstructor"', { cwd: gitRepoPath });
    await execAsync('git config user.email "reconstructor@example.com"', { cwd: gitRepoPath });
    logSuccess(`Git repository initialized at: ${gitRepoPath}`);
    
    // Group files by state
    const states = groupFilesByState(reconstructionData);
    const orderedStates = orderStatesByDate(states);
    const finalState = getFinalState(states);
    
    // If we have a final state, add it to the end
    if (finalState) {
        orderedStates.push(finalState);
    }
    
    logInfo(`Processing ${orderedStates.length} states...`);
    
    // Track current files in the repository
    let currentFiles = {};
    
    // Process each state
    for (let stateIndex = 0; stateIndex < orderedStates.length; stateIndex++) {
        const state = orderedStates[stateIndex];
        const stateDate = state.earliestDate || new Date();
        const stateFiles = state.files;
        const stateDir = Object.keys(states).find(dir => states[dir] === state) || '.';
        
        logInfo(`Processing state ${stateIndex + 1}/${orderedStates.length}: ${stateDir} (${stateDate.toISOString().split('T')[0]})`);
        
        // Determine files to add, modify, and delete
        const filesToAdd = {};
        const filesToModify = {};
        const filesToDelete = {};
        
        // Check each file in the new state
        Object.keys(stateFiles).forEach(filename => {
            const newFile = stateFiles[filename];
            const existingFile = currentFiles[filename];
            
            if (!existingFile) {
                // File doesn't exist in current repo - add it
                filesToAdd[filename] = newFile;
            } else if (newFile.fullPath !== existingFile.fullPath || 
                      new Date(newFile.date) > new Date(existingFile.date)) {
                // File exists but is different or newer - modify it
                filesToModify[filename] = newFile;
            }
            // else: file is the same, no action needed
        });
        
        // Check for files to delete (exist in current but not in new state)
        Object.keys(currentFiles).forEach(filename => {
            if (!stateFiles[filename]) {
                filesToDelete[filename] = currentFiles[filename];
            }
        });
        
        // Perform deletions first
        for (const filename of Object.keys(filesToDelete)) {
            const filePath = path.join(gitRepoPath, filename);
            try {
                if (fs.existsSync(filePath)) {
                    await unlink(filePath);
                    const escapedFilename = escapePath(filename);
                    await execAsync(`git rm ${escapedFilename}`, { 
                        cwd: gitRepoPath,
                        shell: true 
                    });
                    logSuccess(`Deleted: ${filename}`);
                }
            } catch (error) {
                logError(`Failed to delete ${filename}: ${error.message}`);
            }
        }
        
        // Perform additions and modifications
        const filesToProcess = { ...filesToAdd, ...filesToModify };
        for (const filename of Object.keys(filesToProcess)) {
            const file = filesToProcess[filename];
            const targetPath = path.join(gitRepoPath, filename);
            
            try {
                // Copy the file
                if (fs.existsSync(file.fullPath)) {
                    await copyFile(file.fullPath, targetPath);
                } else {
                    logWarn(`Source file not found: ${file.fullPath} - creating empty file`);
                    await writeFile(targetPath, '');
                }
                
                // Set modification time
                try {
                    const date = filetimeToDate(file.filetime);
                    fs.utimesSync(targetPath, date, date);
                } catch (error) {
                    logWarn(`Could not set timestamp for ${filename}: ${error.message}`);
                }
                
                // Add file to git staging area
                const escapedFilename = escapePath(filename);
                await execAsync(`git add ${escapedFilename}`, { 
                    cwd: gitRepoPath,
                    shell: true 
                });
                
                logSuccess(`${filesToAdd[filename] ? 'Added' : 'Modified'}: ${filename}`);
                
            } catch (error) {
                logError(`Failed to process ${filename}: ${error.message}`);
            }
        }
        
        // Commit this state transition
        if (Object.keys(filesToAdd).length > 0 || 
            Object.keys(filesToModify).length > 0 || 
            Object.keys(filesToDelete).length > 0) {
            
            try {
                const gitDate = dateToGitTimestamp(stateDate);
                const commitMessage = `State ${stateIndex + 1}: ${stateDir} - ${stateDate.toLocaleDateString()}`;
                
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
                
                logSuccess(`State ${stateIndex + 1} committed`);
            } catch (error) {
                logError(`State commit failed: ${error.message}`);
            }
        } else {
            logInfo(`No changes for state ${stateIndex + 1}, skipping commit`);
        }
        
        // Update current files to reflect the new state
        currentFiles = JSON.parse(JSON.stringify(stateFiles));
    }
    
    return gitRepoPath;
}

/**
 * Main function
 */
async function main() {
    logHeader('STATE-BASED GIT RECONSTRUCTOR');
    
    const repoName = 'Adrian';
    const jsonPath = path.join(process.cwd(), `${repoName}-commits.json`);
    
    // Load reconstruction data
    let reconstructionData;
    try {
        const data = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
        reconstructionData = { 
            commits: data.commits || [],
            files: data.commits ? data.commits.flatMap(commit => commit.files || []) : [],
            metadata: data.metadata || {}
        };
        logSuccess(`Loaded reconstruction with ${reconstructionData.files.length} files in ${reconstructionData.commits.length} commits`);
    } catch (error) {
        logError(`Failed to load reconstruction data: ${error.message}`);
        process.exit(1);
    }
    
    // Add repoName to metadata if not present
    reconstructionData.metadata.repoName = repoName;
    
    // Create state-based git repository
    try {
        const gitRepoPath = await createStateBasedGitRepository(repoName, reconstructionData, './reconstructed-repos-states');
        
        logHeader('STATE-BASED RECONSTRUCTION COMPLETE');
        logSuccess(`Git repository created: ${gitRepoPath}`);
        logInfo('View your reconstructed repository:');
        console.log(colors.cyan + `  cd "${gitRepoPath}" && git log --oneline` + colors.reset);
        console.log(colors.cyan + `  cd "${gitRepoPath}" && git show` + colors.reset);
        
    } catch (error) {
        logError(`State-based reconstruction failed: ${error.message}`);
        process.exit(1);
    }
}

// Run
main().catch(error => {
    logError(`Fatal error: ${error.message}`);
    process.exit(1);
});