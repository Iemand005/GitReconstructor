#!/usr/bin/env node

/**
 * File Date Snapshot Tool
 * 
 * Snapshots file modification dates with NTFS 100-nanosecond precision
 * and allows lookup from the snapshot database.
 * 
 * Usage:
 *   node fileDateSnapshot.js create <directory> [output.json]
 *   node fileDateSnapshot.js lookup <filePath> [snapshot.json]
 *   node fileDateSnapshot.js check <directory> [snapshot.json]
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

/**
 * NTFS timestamp utilities
 * NTFS stores timestamps as 64-bit FILETIME values representing
 * 100-nanosecond intervals since January 1, 1601 (UTC)
 */
const NTFS_EPOCH = new Date('1601-01-01T00:00:00.000Z');
const UNIX_EPOCH = new Date('1970-01-01T00:00:00.000Z');
const FILETIME_PER_SECOND = 10000000; // 100-nanosecond intervals per second
const FILETIME_PER_MS = 10000; // 100-nanosecond intervals per millisecond

/**
 * Convert a Date object to NTFS FILETIME (100-nanosecond precision)
 * NTFS FILETIME is 100-nanosecond intervals since 1601-01-01 UTC
 * @param {Date} date - JavaScript Date object
 * @returns {string} - NTFS FILETIME as string (to preserve precision)
 */
function dateToNTFSFileTime(date) {
    const unixTimestamp = date.getTime(); // milliseconds since 1970-01-01
    const epochDiffMs = UNIX_EPOCH - NTFS_EPOCH; // difference in milliseconds
    const filetime = (unixTimestamp + epochDiffMs) * FILETIME_PER_MS;
    return filetime.toString();
}

/**
 * Convert NTFS FILETIME back to Date object
 * @param {string|number} filetime - NTFS FILETIME value
 * @returns {Date} - JavaScript Date object
 */
function ntfsFileTimeToDate(filetime) {
    const filetimeNum = parseInt(filetime, 10);
    const epochDiffMs = UNIX_EPOCH - NTFS_EPOCH;
    const unixTimestamp = (filetimeNum / FILETIME_PER_MS) - epochDiffMs;
    return new Date(unixTimestamp);
}

/**
 * Convert Date to ISO string with nanosecond precision
 * @param {Date} date - JavaScript Date object
 * @param {number} nanoseconds - Additional nanoseconds (0-999)
 * @returns {string} - ISO string with nanoseconds
 */
function dateToISOWithNanoseconds(date, nanoseconds = 0) {
    const iso = date.toISOString();
    // Replace the 'Z' at the end with nanoseconds
    const withNano = iso.replace('Z', `.${nanoseconds.toString().padStart(9, '0')}Z`);
    return withNano;
}

/**
 * Get file modification date with maximum precision
 * On NTFS, this will be 100-nanosecond precision
 * @param {string} filePath - Path to the file
 * @returns {Promise<{path: string, mtime: Date, mtimeNs: number, filetime: string}>}
 */
async function getFileModificationDate(filePath) {
    try {
        const stats = await stat(filePath);
        if (!stats.isFile()) {
            throw new Error(`Path is not a file: ${filePath}`);
        }
        
        // stats.mtime is already in nanosecond precision on modern Node.js
        // mtimeNs contains the full nanosecond timestamp
        const mtimeNs = stats.mtimeNs || stats.mtime.getTime() * 1000000; // Convert to nanoseconds
        const mtime = stats.mtime;
        
        // Convert to NTFS FILETIME for storage
        const filetime = dateToNTFSFileTime(mtime);
        
        return {
            path: filePath,
            mtime: mtime.toISOString(),
            mtimeNs: mtimeNs.toString(), // Store as string to preserve precision
            filetime: filetime
        };
    } catch (error) {
        throw new Error(`Error getting modification date for ${filePath}: ${error.message}`);
    }
}

/**
 * Create a snapshot of file modification dates for a directory
 * @param {string} directory - Directory to scan
 * @param {string} outputPath - Path to save the JSON snapshot
 * @param {boolean} recursive - Whether to scan recursively
 * @returns {Promise<Object>} - The snapshot object
 */
async function createSnapshot(directory, outputPath, recursive = true) {
    const snapshot = {
        metadata: {
            created: new Date().toISOString(),
            createdFiletime: dateToNTFSFileTime(new Date()),
            version: '1.0',
            precision: '100ns', // NTFS 100-nanosecond precision
            format: 'NTFS_FILETIME'
        },
        files: {}
    };
    
    try {
        const resolvedDir = path.resolve(directory);
        const files = await getAllFiles(resolvedDir, recursive);
        
        for (const file of files) {
            try {
                const fileDate = await getFileModificationDate(file);
                snapshot.files[file] = {
                    mtime: fileDate.mtime,
                    mtimeNs: fileDate.mtimeNs,
                    filetime: fileDate.filetime
                };
            } catch (error) {
                console.warn(`Warning: Could not get date for ${file}: ${error.message}`);
            }
        }
        
        // Save to JSON
        await writeFile(outputPath, JSON.stringify(snapshot, null, 2));
        
        console.log(`Snapshot created: ${Object.keys(snapshot.files).length} files saved to ${outputPath}`);
        return snapshot;
        
    } catch (error) {
        throw new Error(`Error creating snapshot: ${error.message}`);
    }
}

/**
 * Recursively get all files from a directory
 * @param {string} dirPath - Directory path
 * @param {boolean} recursive - Whether to scan recursively
 * @returns {Promise<Array<string>>} - Array of file paths
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
                    files.push(fullPath);
                } else if (recursive && itemStat.isDirectory()) {
                    // Skip common directories
                    const baseName = path.basename(fullPath);
                    if (!['node_modules', '.git', '.vscode', 'dist', 'build', 'tmp'].includes(baseName)) {
                        const subDirFiles = await getAllFiles(fullPath, recursive);
                        files.push(...subDirFiles);
                    }
                }
            } catch (error) {
                console.warn(`Warning: Could not access ${fullPath}: ${error.message}`);
            }
        }
        
        return files;
    } catch (error) {
        throw new Error(`Error reading directory ${dirPath}: ${error.message}`);
    }
}

/**
 * Load a snapshot from a JSON file
 * @param {string} snapshotPath - Path to the snapshot JSON file
 * @returns {Promise<Object>} - The loaded snapshot
 */
async function loadSnapshot(snapshotPath) {
    try {
        const content = await readFile(snapshotPath, 'utf8');
        const snapshot = JSON.parse(content);
        
        // Validate the snapshot format
        if (!snapshot.metadata || !snapshot.files) {
            throw new Error('Invalid snapshot format');
        }
        
        return snapshot;
    } catch (error) {
        throw new Error(`Error loading snapshot from ${snapshotPath}: ${error.message}`);
    }
}

/**
 * Lookup a file's modification date from a snapshot
 * @param {string} filePath - File path to lookup
 * @param {string} snapshotPath - Path to the snapshot JSON file
 * @returns {Promise<{file: string, mtime: string, mtimeNs: string, filetime: string, source: 'snapshot'|'disk'}>}
 */
async function lookupFileDate(filePath, snapshotPath) {
    try {
        // Load the snapshot
        const snapshot = await loadSnapshot(snapshotPath);
        
        // Resolve the file path for comparison
        const resolvedPath = path.resolve(filePath);
        
        // Check if the file exists in the snapshot
        let snapshotEntry = null;
        for (const [file, entry] of Object.entries(snapshot.files)) {
            if (path.resolve(file) === resolvedPath) {
                snapshotEntry = entry;
                break;
            }
        }
        
        // Get current file date from disk
        const currentFileDate = await getFileModificationDate(resolvedPath);
        
        if (snapshotEntry) {
            // Compare the dates
            const snapshotDateNs = BigInt(snapshotEntry.mtimeNs || snapshotEntry.filetime);
            const currentDateNs = BigInt(currentFileDate.mtimeNs);
            
            // If the file date on disk is newer than the snapshot date, take the snapshotted date
            // This preserves the original date even if the file was modified
            if (currentDateNs > snapshotDateNs) {
                return {
                    file: resolvedPath,
                    mtime: snapshotEntry.mtime,
                    mtimeNs: snapshotEntry.mtimeNs,
                    filetime: snapshotEntry.filetime,
                    source: 'snapshot',
                    currentDate: currentFileDate.mtime,
                    currentDateNs: currentFileDate.mtimeNs,
                    action: 'used_snapshot_date'
                };
            } else {
                // File hasn't been modified since snapshot, use current date
                return {
                    file: resolvedPath,
                    mtime: currentFileDate.mtime,
                    mtimeNs: currentFileDate.mtimeNs,
                    filetime: currentFileDate.filetime,
                    source: 'disk',
                    snapshotDate: snapshotEntry.mtime,
                    snapshotDateNs: snapshotEntry.mtimeNs,
                    action: 'used_disk_date'
                };
            }
        } else {
            // File not in snapshot, return disk date
            return {
                file: resolvedPath,
                mtime: currentFileDate.mtime,
                mtimeNs: currentFileDate.mtimeNs,
                filetime: currentFileDate.filetime,
                source: 'disk',
                action: 'not_in_snapshot'
            };
        }
        
    } catch (error) {
        throw new Error(`Error looking up file date: ${error.message}`);
    }
}

/**
 * Check all files in a directory against a snapshot
 * @param {string} directory - Directory to check
 * @param {string} snapshotPath - Path to the snapshot JSON file
 * @returns {Promise<Object>} - Results of the comparison
 */
async function checkDirectoryAgainstSnapshot(directory, snapshotPath) {
    try {
        const snapshot = await loadSnapshot(snapshotPath);
        const resolvedDir = path.resolve(directory);
        const files = await getAllFiles(resolvedDir, true);
        
        const results = {
            metadata: {
                checked: new Date().toISOString(),
                checkedFiletime: dateToNTFSFileTime(new Date()),
                totalFiles: files.length,
                snapshotDate: snapshot.metadata.created
            },
            unchanged: [],
            modified: [],
            newFiles: [],
            deletedFiles: []
        };
        
        // Create a set of files in the snapshot
        const snapshotFiles = new Set(Object.keys(snapshot.files).map(f => path.resolve(f)));
        
        // Check each file on disk
        for (const file of files) {
            const resolvedFile = path.resolve(file);
            
            if (snapshotFiles.has(resolvedFile)) {
                // File exists in snapshot
                const snapshotEntry = snapshot.files[file];
                const currentFileDate = await getFileModificationDate(file);
                
                const snapshotDateNs = BigInt(snapshotEntry.mtimeNs || snapshotEntry.filetime);
                const currentDateNs = BigInt(currentFileDate.mtimeNs);
                
                if (currentDateNs === snapshotDateNs) {
                    results.unchanged.push({
                        file: resolvedFile,
                        mtime: currentFileDate.mtime,
                        mtimeNs: currentFileDate.mtimeNs
                    });
                } else {
                    results.modified.push({
                        file: resolvedFile,
                        snapshotDate: snapshotEntry.mtime,
                        snapshotDateNs: snapshotEntry.mtimeNs,
                        currentDate: currentFileDate.mtime,
                        currentDateNs: currentFileDate.mtimeNs,
                        olderDate: snapshotEntry.mtime // For preserving old dates
                    });
                }
                
                // Remove from snapshot set to find deleted files
                snapshotFiles.delete(resolvedFile);
            } else {
                // New file not in snapshot
                results.newFiles.push(file);
            }
        }
        
        // Remaining files in snapshot set are deleted files
        results.deletedFiles = Array.from(snapshotFiles).map(f => path.relative(resolvedDir, f));
        
        return results;
        
    } catch (error) {
        throw new Error(`Error checking directory against snapshot: ${error.message}`);
    }
}

/**
 * Get modification date for a file, using snapshot if available and newer
 * @param {string} filePath - File path
 * @param {string} snapshotPath - Path to snapshot JSON (optional)
 * @returns {Promise<{path: string, mtime: string, mtimeNs: string, filetime: string, source: string}>}
 */
async function getFileDateWithSnapshot(filePath, snapshotPath) {
    if (snapshotPath) {
        try {
            return await lookupFileDate(filePath, snapshotPath);
        } catch (error) {
            console.warn(`Warning: Could not use snapshot, falling back to disk: ${error.message}`);
        }
    }
    
    // Fallback to disk date
    return getFileModificationDate(filePath);
}

/**
 * Parse command line arguments
 */
function parseArguments() {
    const args = process.argv.slice(2);
    const options = {
        action: null,
        directory: null,
        file: null,
        snapshot: null,
        recursive: true,
        help: false
    };
    
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        
        if (arg === 'create') {
            options.action = 'create';
            i++;
        } else if (arg === 'lookup') {
            options.action = 'lookup';
            i++;
        } else if (arg === 'check') {
            options.action = 'check';
            i++;
        } else if (arg === '--snapshot' || arg === '-s') {
            options.snapshot = args[++i];
            i++;
        } else if (arg === '--recursive' || arg === '-r') {
            options.recursive = true;
            i++;
        } else if (arg === '--non-recursive' || arg === '-R') {
            options.recursive = false;
            i++;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg.startsWith('--')) {
            console.error(`Unknown option: ${arg}`);
            process.exit(1);
        } else {
            if (options.action === 'create' && options.directory === null) {
                options.directory = arg;
            } else if ((options.action === 'lookup' || options.action === 'check') && options.file === null) {
                options.file = arg;
            } else if (options.directory === null && !options.action) {
                // If no action specified, default to create
                options.action = 'create';
                options.directory = arg;
            } else if (options.snapshot === null) {
                options.snapshot = arg;
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
File Date Snapshot Tool - NTFS 100ns Precision

Usage:
  node fileDateSnapshot.js create <directory> [snapshot.json]
  node fileDateSnapshot.js lookup <filePath> [snapshot.json]
  node fileDateSnapshot.js check <directory> <snapshot.json>

Actions:
  create    Create a new snapshot of file modification dates
  lookup    Lookup a file's date (uses snapshot if available)
  check     Check directory against snapshot for changes

Options:
  -s, --snapshot <file>   Snapshot JSON file to use
  -r, --recursive         Scan directories recursively (default: true)
  -R, --non-recursive     Do not scan recursively
  -h, --help              Show this help message

Examples:
  # Create snapshot of current directory
  node fileDateSnapshot.js create ./my-project dates.json

  # Lookup a file's date using snapshot
  node fileDateSnapshot.js lookup ./src/file.js dates.json

  # Check directory against snapshot
  node fileDateSnapshot.js check ./src dates.json

NTFS Precision:
  - Stores dates with 100-nanosecond precision (NTFS FILETIME format)
  - Preserves original modification dates even if files are modified
  - When file on disk is newer than snapshot, returns snapshot date
`);
}

/**
 * Main function
 */
async function main() {
    const options = parseArguments();
    
    if (options.help || !options.action) {
        showHelp();
        return;
    }
    
    try {
        switch (options.action) {
            case 'create':
                if (!options.directory) {
                    console.error('Error: Directory must be specified for create action');
                    process.exit(1);
                }
                
                const snapshotPath = options.snapshot || path.join(options.directory, 'fileDatesSnapshot.json');
                await createSnapshot(options.directory, snapshotPath, options.recursive);
                break;
                
            case 'lookup':
                if (!options.file) {
                    console.error('Error: File path must be specified for lookup action');
                    process.exit(1);
                }
                
                if (!options.snapshot) {
                    console.error('Error: Snapshot file must be specified for lookup action');
                    process.exit(1);
                }
                
                const result = await lookupFileDate(options.file, options.snapshot);
                console.log(JSON.stringify(result, null, 2));
                break;
                
            case 'check':
                if (!options.file) {
                    console.error('Error: Directory must be specified for check action');
                    process.exit(1);
                }
                
                if (!options.snapshot) {
                    console.error('Error: Snapshot file must be specified for check action');
                    process.exit(1);
                }
                
                const checkResult = await checkDirectoryAgainstSnapshot(options.file, options.snapshot);
                console.log(JSON.stringify(checkResult, null, 2));
                break;
                
            default:
                console.error(`Error: Unknown action: ${options.action}`);
                process.exit(1);
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
    getFileModificationDate,
    dateToNTFSFileTime,
    ntfsFileTimeToDate,
    createSnapshot,
    loadSnapshot,
    lookupFileDate,
    checkDirectoryAgainstSnapshot,
    getFileDateWithSnapshot,
    getAllFiles
};