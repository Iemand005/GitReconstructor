#!/usr/bin/env node

/**
 * Node.js tool to get the modification date of files
 * 
 * Usage:
 *   node getFileModificationDate.js <fileOrDirectoryPath> [options]
 * 
 * Examples:
 *   node getFileModificationDate.js file.txt
 *   node getFileModificationDate.js ./src --recursive
 *   node getFileModificationDate.js *.js --format=json
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const stat = promisify(fs.stat);
const readdir = promisify(fs.readdir);

/**
 * Get modification date of a single file
 * @param {string} filePath - Path to the file
 * @returns {Promise<{path: string, modified: Date, size?: number}>}
 */
async function getFileModDate(filePath) {
    try {
        const stats = await stat(filePath);
        if (!stats.isFile()) {
            throw new Error(`Path is not a file: ${filePath}`);
        }
        return {
            path: filePath,
            modified: stats.mtime,
            size: stats.size
        };
    } catch (error) {
        throw new Error(`Error getting modification date for ${filePath}: ${error.message}`);
    }
}

/**
 * Get modification dates for all files in a directory
 * @param {string} dirPath - Path to the directory
 * @param {boolean} recursive - Whether to search recursively
 * @returns {Promise<Array<{path: string, modified: Date, size?: number}>>}
 */
async function getDirectoryModDates(dirPath, recursive = false) {
    const results = [];
    
    try {
        const items = await readdir(dirPath);
        
        for (const item of items) {
            const fullPath = path.join(dirPath, item);
            const itemStat = await stat(fullPath);
            
            if (itemStat.isFile()) {
                results.push({
                    path: fullPath,
                    modified: itemStat.mtime,
                    size: itemStat.size
                });
            } else if (recursive && itemStat.isDirectory()) {
                const subDirResults = await getDirectoryModDates(fullPath, recursive);
                results.push(...subDirResults);
            }
        }
        
        return results;
    } catch (error) {
        throw new Error(`Error reading directory ${dirPath}: ${error.message}`);
    }
}

/**
 * Get modification dates for multiple files using glob patterns
 * @param {string} pattern
 * @returns {Promise<Array<{path: string, modified: Date, size?: number}>>}
 */
async function getFilesByPattern(pattern) {
    const glob = require('glob');
    return new Promise((resolve, reject) => {
        glob(pattern, { nodir: true }, async (error, files) => {
            if (error) {
                reject(new Error(`Error with glob pattern "${pattern}": ${error.message}`));
                return;
            }
            
            try {
                const results = [];
                for (const file of files) {
                    const fileInfo = await getFileModDate(file);
                    results.push(fileInfo);
                }
                resolve(results);
            } catch (err) {
                reject(err);
            }
        });
    });
}

/**
 * Parse command line arguments
 * @returns {{paths: string[], recursive: boolean, format: string, help: boolean}}
 */
function parseArguments() {
    const args = process.argv.slice(2);
    const options = {
        paths: [],
        recursive: false,
        format: 'table',
        help: false,
        json: false
    };
    
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        
        if (arg === '--recursive' || arg === '-r') {
            options.recursive = true;
            i++;
        } else if (arg === '--format' || arg === '-f') {
            options.format = args[++i];
            i++;
        } else if (arg === '--json' || arg === '-j') {
            options.json = true;
            options.format = 'json';
            i++;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg.startsWith('--')) {
            console.error(`Unknown option: ${arg}`);
            process.exit(1);
        } else {
            options.paths.push(arg);
            i++;
        }
    }
    
    return options;
}

/**
 * Format the results as a table
 * @param {Array<{path: string, modified: Date, size?: number}>} results
 * @returns {string}
 */
function formatAsTable(results) {
    if (results.length === 0) return 'No files found.';
    
    // Sort by modification date (newest first)
    results.sort((a, b) => b.modified - a.modified);
    
    // Find the longest path for alignment
    const maxPathLength = Math.max(...results.map(r => r.path.length), 10);
    
    let output = '';
    output += 'File'.padEnd(maxPathLength) + ' | Modified Date           | Size\n';
    output += '-'.repeat(maxPathLength) + ' | ' + '-'.repeat(21) + ' | ' + '-'.repeat(8) + '\n';
    
    results.forEach(file => {
        const formattedDate = file.modified.toISOString().replace('T', ' ').slice(0, 19);
        const size = file.size ? formatFileSize(file.size) : 'N/A';
        const displayPath = file.path.length > maxPathLength 
            ? '...' + file.path.slice(-(maxPathLength - 3))
            : file.path;
        output += displayPath.padEnd(maxPathLength) + ' | ' + formattedDate + ' | ' + size + '\n';
    });
    
    return output;
}

/**
 * Format file size in human readable format
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/**
 * Display help information
 */
function showHelp() {
    console.log(`
Node.js File Modification Date Tool

Usage:
  node getFileModificationDate.js <path> [options]

Arguments:
  <path>                File path, directory path, or glob pattern

Options:
  -r, --recursive       Search directories recursively
  -f, --format <type>  Output format: 'table' (default), 'json'
  -j, --json           Output as JSON
  -h, --help           Show this help message

Examples:
  # Get modification date of a single file
  node getFileModificationDate.js file.txt

  # Get modification dates of all files in a directory
  node getFileModificationDate.js ./src --recursive

  # Get modification dates using glob pattern
  node getFileModificationDate.js "*.js"

  # Output as JSON
  node getFileModificationDate.js ./src --json

  # Get newest files first
  node getFileModificationDate.js ./src --recursive | sort
`);
}

/**
 * Main function
 */
async function main() {
    const options = parseArguments();
    
    if (options.help || options.paths.length === 0) {
        showHelp();
        return;
    }
    
    try {
        const allResults = [];
        
        for (const pathArg of options.paths) {
            const resolvedPath = path.resolve(pathArg);
            
            try {
                const stats = await stat(resolvedPath);
                
                if (stats.isFile()) {
                    const result = await getFileModDate(resolvedPath);
                    allResults.push(result);
                } else if (stats.isDirectory()) {
                    const results = await getDirectoryModDates(resolvedPath, options.recursive);
                    allResults.push(...results);
                } else {
                    // Try as glob pattern
                    const globResults = await getFilesByPattern(pathArg);
                    allResults.push(...globResults);
                }
            } catch (error) {
                // If the path doesn't exist, try as glob pattern
                try {
                    const globResults = await getFilesByPattern(pathArg);
                    allResults.push(...globResults);
                } catch (globError) {
                    console.error(`Error processing path "${pathArg}": ${error.message}`);
                    process.exit(1);
                }
            }
        }
        
        // Remove duplicates (in case glob patterns overlap)
        const uniqueResults = [];
        const seenPaths = new Set();
        allResults.forEach(result => {
            if (!seenPaths.has(result.path)) {
                seenPaths.add(result.path);
                uniqueResults.push(result);
            }
        });
        
        // Output results
        if (options.format === 'json' || options.json) {
            console.log(JSON.stringify(uniqueResults, null, 2));
        } else {
            console.log(formatAsTable(uniqueResults));
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
    getFileModDate,
    getDirectoryModDates,
    getFilesByPattern,
    formatAsTable
};