#!/usr/bin/env node

/**
 * GitReconstructor - Reconstructs file history from copies/backups
 * 
 * Analyzes a directory with files that have copies (like "index.html", "index.htmla", etc.)
 * and creates a JSON database that represents the reconstructed git-like history.
 * 
 * Usage:
 *   node gitReconstructor.js <directory> [output.json]
 * 
 * Example:
 *   node gitReconstructor.js ./Repos/Adrian git-history.json
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

/**
 * Recursively get all files from a directory
 * @param {string} dirPath - Directory path
 * @param {boolean} recursive - Whether to scan recursively
 * @returns {Promise<Array<{path: string, filename: string, stat: object}>>}
 */
async function getAllFiles(dirPath, recursive = true) {
    const files = [];
    
    try {
        const items = await readdir(dirPath);
        
        for (const item of items) {
            const fullPath = path.join(dirPath, item);
            
            try {
                const itemStat = await stat(fullPath);
                
                if (itemStat.isFile()) {
                    files.push({
                        path: fullPath,
                        filename: item,
                        stat: itemStat
                    });
                } else if (recursive && itemStat.isDirectory()) {
                    const subDirFiles = await getAllFiles(fullPath, recursive);
                    files.push(...subDirFiles);
                }
            } catch (error) {
                // Skip files we can't access
                console.warn(`Warning: Could not access ${fullPath}: ${error.message}`);
            }
        }
        
        return files;
    } catch (error) {
        throw new Error(`Error reading directory ${dirPath}: ${error.message}`);
    }
}

/**
 * Normalize a filename to its base form
 * Removes common copy/backup suffixes like "- kopie", "(2)", " copy", etc.
 * @param {string} filename - The filename to normalize
 * @returns {string} - The normalized base filename
 */
function normalizeFilename(filename) {
    // Remove path and extension
    const basename = path.parse(filename).name;
    const ext = path.parse(filename).ext;
    
    // Remove common copy indicators
    let normalized = basename
        // Remove "- kopie" and variants
        .replace(/\s*-?\s*kopie\s*(?:\(\d+\))?\s*$/i, '')
        // Remove " copy", " - copy", etc.
        .replace(/\s*-?\s*copy\s*(?:\(\d+\))?\s*$/i, '')
        // Remove trailing numbers in parentheses like "(2)", "(1)" etc.
        .replace(/\s*\(\d+\)\s*$/i, '')
        // Remove trailing "- backup", "_backup", etc.
        .replace(/\s*-?\s*backup\s*$/i, '')
        // Remove trailing "~", ".bak", "_old", etc.
        .replace(/[~_\-\.]?bak$/i, '')
        .replace(/[~_\-]old$/i, '')
        .replace(/\.$/, '') // Remove trailing dots
        .trim();
    
    return normalized + ext;
}

/**
 * Get base name without any copy indicators for grouping
 * Also handles variant names like "indexe", "indext", etc.
 * @param {string} filename - The filename
 * @returns {string} - Base name for grouping
 */
function getBaseNameForGrouping(filename) {
    const basename = path.parse(filename).name;
    const ext = path.parse(filename).ext;
    
    // Remove all copy indicators to get the true base name
    let base = basename
        .replace(/\s*-?\s*kopie\s*(?:\(\d+\))?/gi, '')
        .replace(/\s*-?\s*copy\s*(?:\(\d+\))?/gi, '')
        .replace(/\(\d+\)/g, '')
        .replace(/[~_\-\.]?bak$/i, '')
        .replace(/[~_\-]old$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    
    // Also try to match common variant patterns
    // e.g., "indexe" -> "index", "indext" -> "index", "Birthday Counter 2" -> "Birthday Counter"
    // Remove trailing letters that are common variations
    const variants = [
        /e$/i,      // "indexe" -> "index"
        /a$/i,      // "indexa" -> "index" 
        /t$/i,      // "indext" -> "index"
        /\d+$/i,    // trailing numbers
        / [2-9]$/i, // " 2", " 3", etc. at the end
        / \(2\)/i, // " (2)"
        /-2$/i,     // "-2"
        /_2$/i      // "_2"
    ];
    
    for (const variant of variants) {
        if (variant.test(base)) {
            base = base.replace(variant, '');
            break; // Only remove one variant at a time
        }
    }
    
    // Also handle specific known patterns in this dataset
    if (base.match(/^index[ea]$/i)) {
        base = 'index';
    }
    if (base.match(/^Birthday Counter \d+$/i)) {
        base = 'Birthday Counter';
    }
    if (base.match(/^index compat$/i)) {
        base = 'index';
    }
    if (base.match(/^indexDonedenkik$/i)) {
        base = 'index';
    }
    if (base.match(/^indexwow$/i)) {
        base = 'index';
    }
    if (base.match(/^indexta$/i)) {
        base = 'index';
    }
    if (base.match(/^indexe$/i)) {
        base = 'index';
    }
    
    return base;
}

/**
 * Group files by their base names
 * @param {Array<{path: string, filename: string, stat: object}>} files - Array of file info
 * @returns {Object} - Groups of files
 */
function groupFilesByBaseName(files) {
    const groups = {};
    
    files.forEach(file => {
        const baseName = getBaseNameForGrouping(file.filename);
        if (!groups[baseName]) {
            groups[baseName] = [];
        }
        groups[baseName].push(file);
    });
    
    return groups;
}

/**
 * Determine the primary file in a group
 * The primary file is typically the most recent or the one without copy indicators
 * @param {Array<{path: string, filename: string, stat: object}>} fileGroup - Group of files
 * @returns {{path: string, filename: string, stat: object}} - The primary file
 */
function determinePrimaryFile(fileGroup) {
    // Sort by modification time (newest first)
    const sorted = [...fileGroup].sort((a, b) => 
        b.stat.mtime.getTime() - a.stat.mtime.getTime()
    );
    
    // Look for files with clean names (no copy indicators, no variant endings)
    const cleanNameFiles = sorted.filter(file => {
        const basename = path.parse(file.filename).name;
        return !basename.match(/- kopie|copy|\(\d+\)|backup|bak|old/i) &&
               !basename.match(/e$/i) &&
               !basename.match(/a$/i) &&
               !basename.match(/t$/i) &&
               !basename.match(/wow$/i) &&
               !basename.match(/Donedenkik$/i) &&
               !basename.match(/compat$/i) &&
               !basename.match(/\d+$/i);
    });
    
    if (cleanNameFiles.length > 0) {
        return cleanNameFiles[0]; // Newest file with clean name
    }
    
    // If no clean names, pick the one with the shortest name (likely most canonical)
    sorted.sort((a, b) => a.filename.length - b.filename.length);
    return sorted[0];
}

/**
 * Sort files in a group by modification time (oldest to newest)
 * @param {Array<{path: string, filename: string, stat: object}>} fileGroup
 * @returns {Array} - Sorted files
 */
function sortFilesByDate(fileGroup) {
    return [...fileGroup].sort((a, b) => 
        a.stat.mtime.getTime() - b.stat.mtime.getTime()
    );
}

/**
 * Convert Windows FILETIME (100ns since 1601) to nanoseconds timestamp
 * @param {string} filetime - Windows FILETIME string
 * @returns {string} - Nanosecond timestamp
 */
function filetimeToNanoseconds(filetime) {
    // FILETIME is 100-nanosecond intervals since 1601-01-01
    const filetimeNum = BigInt(filetime);
    const epochDiff = 116444736000000000n; // Difference between 1601 and 1970 in 100ns units
    const unixNs = filetimeNum - epochDiff; // Convert to Unix epoch in 100ns units
    const nanoseconds = unixNs * 100n; // Convert to nanoseconds
    return nanoseconds.toString();
}

/**
 * Get filetime from stat object
 * @param {object} stat - File stat object
 * @returns {string} - FILETIME string
 */
function getFiletimeFromStat(stat) {
    // On Windows, we can get the actual FILETIME from the stat object
    // On Unix-like systems, we'll use mtime
    const mtimeNs = stat.mtimeNs || stat.mtime.getTime() * 1000000;
    
    // Convert to Windows FILETIME (100ns since 1601)
    // Unix epoch (1970) to Windows epoch (1601) is 11644473600 seconds
    const windowsEpochDiff = 116444736000000000n; // in 100ns units
    const unixEpochNs = BigInt(mtimeNs);
    const filetime = (windowsEpochDiff + unixEpochNs / 100n).toString();
    
    return filetime;
}

/**
 * Create reconstructed git history JSON
 * @param {Array<{path: string, filename: string, stat: object}>} files - Array of files
 * @returns {Object} - Reconstructed history
 */
function createReconstructedHistory(files) {
    const groups = groupFilesByBaseName(files);
    const history = [];
    
    for (const [baseName, fileGroup] of Object.entries(groups)) {
        if (fileGroup.length === 1) {
            // Single file, no versions
            const file = fileGroup[0];
            history.push({
                originalFilename: file.filename,
                path: file.path,
                date: file.stat.mtime.toISOString(),
                filetime: getFiletimeFromStat(file.stat),
                nanoseconds: file.stat.mtimeNs || (file.stat.mtime.getTime() * 1000000).toString(),
                versions: []
            });
        } else {
            // Multiple files, create version history
            const primaryFile = determinePrimaryFile(fileGroup);
            const sortedFiles = sortFilesByDate(fileGroup);
            
            const entry = {
                originalFilename: primaryFile.filename,
                path: primaryFile.path,
                date: primaryFile.stat.mtime.toISOString(),
                filetime: getFiletimeFromStat(primaryFile.stat),
                nanoseconds: primaryFile.stat.mtimeNs || (primaryFile.stat.mtime.getTime() * 1000000).toString(),
                versions: []
            };
            
            // Add all files as versions, sorted by date
            for (const versionFile of sortedFiles) {
                if (versionFile.path === primaryFile.path) {
                    // Skip the primary file itself
                    continue;
                }
                
                entry.versions.push({
                    path: versionFile.path,
                    filename: versionFile.filename,
                    date: versionFile.stat.mtime.toISOString(),
                    filetime: getFiletimeFromStat(versionFile.stat),
                    nanoseconds: versionFile.stat.mtimeNs || (versionFile.stat.mtime.getTime() * 1000000).toString()
                });
            }
            
            history.push(entry);
        }
    }
    
    // Sort history by primary file date (newest first)
    history.sort((a, b) => 
        new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    
    return history;
}

/**
 * Create a git-like commit history from files
 * This groups files and creates "commits" based on date clusters
 * @param {Array<{path: string, filename: string, stat: object}>} files - Array of files
 * @returns {Object} - Git-like history with commits
 */
function createGitLikeHistory(files) {
    const groups = groupFilesByBaseName(files);
    const allEntries = [];
    
    // Create entries for each file version
    for (const [baseName, fileGroup] of Object.entries(groups)) {
        const primaryFile = determinePrimaryFile(fileGroup);
        const sortedFiles = sortFilesByDate(fileGroup);
        
        for (let i = 0; i < sortedFiles.length; i++) {
            const file = sortedFiles[i];
            const isPrimary = file.path === primaryFile.path;
            
            allEntries.push({
                originalFilename: primaryFile.filename,
                path: file.path,
                filename: file.filename,
                date: file.stat.mtime.toISOString(),
                filetime: getFiletimeFromStat(file.stat),
                nanoseconds: file.stat.mtimeNs || (file.stat.mtime.getTime() * 1000000).toString(),
                isPrimary: isPrimary,
                versionIndex: i + 1,
                totalVersions: sortedFiles.length
            });
        }
    }
    
    // Group entries by date to create "commits"
    // Files modified at the same time (within 1 second) are grouped as a commit
    const commits = [];
    const sortedEntries = allEntries.sort((a, b) => 
        new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    
    let currentCommit = null;
    let lastTimestamp = null;
    
    for (const entry of sortedEntries) {
        const currentTimestamp = new Date(entry.date).getTime();
        
        if (!currentCommit || (lastTimestamp && currentTimestamp - lastTimestamp > 1000)) {
            // Start a new commit if it's more than 1 second different
            if (currentCommit) {
                commits.push(currentCommit);
            }
            currentCommit = {
                timestamp: entry.date,
                filetime: entry.filetime,
                files: []
            };
        }
        
        currentCommit.files.push(entry);
        lastTimestamp = currentTimestamp;
    }
    
    if (currentCommit) {
        commits.push(currentCommit);
    }
    
    return {
        metadata: {
            created: new Date().toISOString(),
            fileCount: files.length,
            commitCount: commits.length,
            format: 'git-like'
        },
        commits: commits.map(commit => ({
            timestamp: commit.timestamp,
            filetime: commit.filetime,
            fileCount: commit.files.length,
            files: commit.files
        }))
    };
}

/**
 * Parse command line arguments
 */
function parseArguments() {
    const args = process.argv.slice(2);
    const options = {
        directory: null,
        output: null,
        format: 'history', // 'history' or 'git'
        help: false
    };
    
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        
        if (arg === '--format' || arg === '-f') {
            options.format = args[++i];
            i++;
        } else if (arg === '--output' || arg === '-o') {
            options.output = args[++i];
            i++;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg.startsWith('--')) {
            console.error(`Unknown option: ${arg}`);
            process.exit(1);
        } else {
            if (options.directory === null) {
                options.directory = arg;
            } else if (options.output === null) {
                options.output = arg;
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
GitReconstructor - Reconstruct file history from backups/copies

Usage:
  node gitReconstructor.js <directory> [output.json] [options]

Arguments:
  <directory>     Directory to scan for files
  [output.json]   Output JSON file (default: git-history.json)

Options:
  -f, --format <type>  Output format: 'history' (default), 'git'
                      'history' = grouped by filename with versions
                      'git' = organized as git-like commits
  -o, --output <file>  Output JSON file
  -h, --help           Show this help message

Examples:
  # Create history file for Adrian's repo
  node gitReconstructor.js ./Repos/Adrian adrian-history.json

  # Create git-like commit history
  node gitReconstructor.js ./Repos/Adrian -f git adrian-commits.json

How it works:
  - Scans the specified directory recursively
  - Groups files by their base names (ignoring copy indicators like "- kopie", "(2)", etc.)
  - Creates entries with original filename as primary name
  - Each file version has path, filename, date, and nanosecond timestamps
  - Outputs JSON that represents reconstructed file history

Copy indicators recognized:
  - "- kopie", "- copy"
  - "(2)", "(3)", etc.
  - "backup", ".bak", "_old"
  - Trailing numbers and dots
`);
}

/**
 * Main function
 */
async function main() {
    const options = parseArguments();
    
    if (options.help || !options.directory) {
        showHelp();
        return;
    }
    
    try {
        console.log(`Scanning directory: ${options.directory}`);
        
        // Get all files
        const files = await getAllFiles(options.directory, true);
        
        if (files.length === 0) {
            console.log('No files found in the specified directory.');
            return;
        }
        
        console.log(`Found ${files.length} files`);
        
        let result;
        switch (options.format) {
            case 'git':
                result = createGitLikeHistory(files);
                break;
            case 'history':
            default:
                result = createReconstructedHistory(files);
                break;
        }
        
        // Determine output path
        const outputPath = options.output || path.join(process.cwd(), 'git-history.json');
        
        // Save to JSON
        await writeFile(outputPath, JSON.stringify(result, null, 2));
        
        console.log(`Reconstructed history saved to: ${outputPath}`);
        console.log(`Format: ${options.format}`);
        
        // Show summary
        if (options.format === 'history') {
            console.log(`\nSummary:`);
            console.log(`- Total files: ${files.length}`);
            console.log(`- Unique base names: ${result.length}`);
            
            const filesWithVersions = result.filter(entry => entry.versions.length > 0).length;
            console.log(`- Files with versions: ${filesWithVersions}`);
        } else {
            console.log(`\nSummary:`);
            console.log(`- Total files: ${files.length}`);
            console.log(`- Total commits: ${result.metadata.commitCount}`);
        }
        
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

// Run the tool
main();

// Export functions for use as a module
module.exports = {
    getAllFiles,
    normalizeFilename,
    getBaseNameForGrouping,
    groupFilesByBaseName,
    determinePrimaryFile,
    sortFilesByDate,
    createReconstructedHistory,
    createGitLikeHistory,
    getFiletimeFromStat,
    filetimeToNanoseconds
};