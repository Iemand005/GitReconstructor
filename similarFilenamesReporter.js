#!/usr/bin/env node

/**
 * Similar Filenames Reporter
 * 
 * Recursively scans a directory and groups files with similar names together.
 * Shows frequency of filename patterns and groups similar names.
 * 
 * Usage:
 *   node similarFilenamesReporter.js <directory> [options]
 * 
 * Examples:
 *   node similarFilenamesReporter.js ./src
 *   node similarFilenamesReporter.js . --threshold=0.7 --min-group=2
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

// Import the string-similarity module
let stringSimilarity;
try {
    stringSimilarity = require('string-similarity');
} catch (e) {
    console.error('Error: string-similarity module not found. Install with: npm install string-similarity');
    process.exit(1);
}

/**
 * Recursively get all files from a directory
 * @param {string} dirPath - Directory path
 * @param {boolean} includeHidden - Whether to include hidden files
 * @returns {Promise<Array<string>>} - Array of file paths
 */
async function getAllFiles(dirPath, includeHidden = false) {
    const files = [];
    
    try {
        const items = await readdir(dirPath);
        
        for (const item of items) {
            // Skip hidden files if not requested
            if (!includeHidden && item.startsWith('.')) {
                continue;
            }
            
            const fullPath = path.join(dirPath, item);
            
            try {
                const itemStat = await stat(fullPath);
                
                if (itemStat.isFile()) {
                    files.push({
                        fullPath: fullPath,
                        filename: item,
                        directory: dirPath
                    });
                } else if (itemStat.isDirectory()) {
                    // Skip common directories that we usually don't want to scan
                    const baseName = path.basename(fullPath);
                    if (!['node_modules', '.git', '.vscode', 'dist', 'build', 'tmp'].includes(baseName)) {
                        const subDirFiles = await getAllFiles(fullPath, includeHidden);
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
 * Extract filename without extension
 * @param {string} filename - Full filename with extension
 * @returns {string} - Filename without extension
 */
function getBaseName(filename) {
    return path.parse(filename).name;
}

/**
 * Get file extension
 * @param {string} filename - Full filename
 * @returns {string} - Extension without dot
 */
function getExtension(filename) {
    return path.parse(filename).ext.replace('.', '') || '';
}

/**
 * Group similar filenames together using string similarity
 * @param {Array<string>} filenames - Array of filenames
 * @param {number} threshold - Similarity threshold (0-1)
 * @returns {Array<{name: string, files: string[], count: number}>} - Groups of similar filenames
 */
function groupSimilarFilenames(filenames, threshold = 0.6) {
    const groups = [];
    const usedIndices = new Set();
    
    // Sort filenames alphabetically for consistent results
    filenames.sort();
    
    for (let i = 0; i < filenames.length; i++) {
        if (usedIndices.has(i)) continue;
        
        const currentFile = filenames[i];
        const similarFiles = [currentFile];
        
        // Find all files similar to the current one
        for (let j = i + 1; j < filenames.length; j++) {
            if (usedIndices.has(j)) continue;
            
            const similarity = stringSimilarity.compareTwoStrings(currentFile, filenames[j]);
            
            if (similarity >= threshold) {
                similarFiles.push(filenames[j]);
                usedIndices.add(j);
            }
        }
        
        if (similarFiles.length > 0) {
            groups.push({
                name: similarFiles[0], // Use first file as group name
                files: similarFiles,
                count: similarFiles.length
            });
        }
        
        usedIndices.add(i);
    }
    
    // Sort groups by count (largest first), then by name
    return groups.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Analyze filename patterns and extensions
 * @param {Array<{fullPath: string, filename: string, directory: string}>} files
 * @returns {Object} - Analysis results
 */
function analyzeFilenamePatterns(files) {
    const analysis = {
        totalFiles: files.length,
        filenameFrequency: {},
        extensionFrequency: {},
        baseNameFrequency: {},
        directories: {}
    };
    
    files.forEach(file => {
        // Count filename frequency (exact matches)
        analysis.filenameFrequency[file.filename] = (analysis.filenameFrequency[file.filename] || 0) + 1;
        
        // Count extension frequency
        const ext = getExtension(file.filename);
        if (ext) {
            analysis.extensionFrequency[ext] = (analysis.extensionFrequency[ext] || 0) + 1;
        }
        
        // Count base name frequency (without extension)
        const baseName = getBaseName(file.filename);
        analysis.baseNameFrequency[baseName] = (analysis.baseNameFrequency[baseName] || 0) + 1;
        
        // Track which directory files are in
        analysis.directories[file.directory] = (analysis.directories[file.directory] || 0) + 1;
    });
    
    return analysis;
}

/**
 * Format a filename report
 * @param {Array<{fullPath: string, filename: string, directory: string}>} files
 * @param {Object} analysis - Analysis results
 * @param {Array} similarGroups - Groups of similar filenames
 * @param {number} threshold - Similarity threshold used
 * @returns {string} - Formatted report
 */
function formatReport(files, analysis, similarGroups, threshold) {
    let report = '';
    
    // Header
    report += '='.repeat(80) + '\n';
    report += 'SIMILAR FILENAMES REPORT'.padStart(40 + Math.floor(40/2)) + '\n';
    report += '='.repeat(80) + '\n\n';
    
    // Summary
    report += `Directory scanned: ${files.length > 0 ? path.dirname(files[0].fullPath) : 'N/A'}\n`;
    report += `Total files found: ${analysis.totalFiles}\n`;
    report += `Similarity threshold: ${threshold}\n`;
    report += `Group count: ${similarGroups.length}\n\n`;
    
    // Most common extensions
    report += '--- MOST COMMON EXTENSIONS ---\n';
    const sortedExtensions = Object.entries(analysis.extensionFrequency)
        .sort((a, b) => b[1] - a[1]);
    
    const maxExtCount = sortedExtensions.length > 0 ? sortedExtensions[0][1] : 0;
    const extNameWidth = Math.min(10, Math.max(...sortedExtensions.map(([ext]) => ext.length)));
    
    sortedExtensions.forEach(([ext, count]) => {
        const barLength = Math.round((count / maxExtCount) * 30);
        const bar = '█'.repeat(barLength);
        report += `  ${ext.padEnd(extNameWidth)}: ${count.toString().padStart(4)} files  ${bar}\n`;
    });
    report += '\n';
    
    // Most common base names
    report += '--- MOST COMMON BASE NAMES (without extension) ---\n';
    const sortedBaseNames = Object.entries(analysis.baseNameFrequency)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10); // Top 10
    
    const maxBaseNameCount = sortedBaseNames.length > 0 ? sortedBaseNames[0][1] : 0;
    const baseNameWidth = Math.min(20, Math.max(...sortedBaseNames.map(([name]) => name.length)));
    
    sortedBaseNames.forEach(([baseName, count]) => {
        const barLength = Math.round((count / maxBaseNameCount) * 30);
        const bar = '█'.repeat(barLength);
        report += `  ${baseName.padEnd(baseNameWidth)}: ${count.toString().padStart(3)} files  ${bar}\n`;
    });
    report += '\n';
    
    // Similar filename groups
    report += '--- SIMILAR FILENAME GROUPS ---\n';
    
    similarGroups.forEach((group, index) => {
        if (group.count === 1) {
            // Don't show single-file groups if they're not similar to anything
            return;
        }
        
        report += `${index + 1}. ${group.name} (${group.count} similar files)\n`;
        group.files.forEach(file => {
            if (file !== group.name) {
                report += `   └── ${file}\n`;
            }
        });
        report += '\n';
    });
    
    // Files by directory
    report += '--- FILES BY DIRECTORY ---\n';
    const sortedDirs = Object.entries(analysis.directories)
        .sort((a, b) => b[1] - a[1]);
    
    sortedDirs.forEach(([dir, count]) => {
        report += `  ${dir}: ${count} files\n`;
    });
    report += '\n';
    
    // Detailed file list (optional, could be long)
    if (files.length <= 50) {
        report += '--- ALL FILES FOUND ---\n';
        files.sort((a, b) => a.filename.localeCompare(b.filename));
        files.forEach(file => {
            report += `  ${file.filename}\n`;
        });
        report += '\n';
    } else {
        report += `--- All files: ${files.length} files (use --all to show) ---\n\n`;
    }
    
    report += '='.repeat(80) + '\n';
    
    return report;
}

/**
 * Parse command line arguments
 */
function parseArguments() {
    const args = process.argv.slice(2);
    const options = {
        directory: null,
        threshold: 0.7,
        includeHidden: false,
        all: false,
        help: false
    };
    
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        
        if (arg === '--threshold' || arg === '-t') {
            options.threshold = parseFloat(args[++i]);
            if (isNaN(options.threshold) || options.threshold < 0 || options.threshold > 1) {
                console.error('Error: Threshold must be a number between 0 and 1');
                process.exit(1);
            }
            i++;
        } else if (arg === '--include-hidden' || arg === '-H') {
            options.includeHidden = true;
            i++;
        } else if (arg === '--all' || arg === '-a') {
            options.all = true;
            i++;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg.startsWith('--')) {
            console.error(`Unknown option: ${arg}`);
            process.exit(1);
        } else {
            if (options.directory === null) {
                options.directory = arg;
            } else {
                console.error('Error: Only one directory can be specified');
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
Similar Filenames Reporter

Usage:
  node similarFilenamesReporter.js <directory> [options]

Arguments:
  <directory>           Directory to scan for files

Options:
  -t, --threshold <n>  Similarity threshold (0-1, default: 0.7)
                      Higher = more strict similarity
  -H, --include-hidden Include hidden files and directories
  -a, --all            Show all files in the report (not just summary)
  -h, --help           Show this help message

Examples:
  # Scan current directory
  node similarFilenamesReporter.js .

  # Scan with lower similarity threshold
  node similarFilenamesReporter.js ./src --threshold=0.5

  # Include hidden files
  node similarFilenamesReporter.js . --include-hidden

  # Show all files
  node similarFilenamesReporter.js ./src --all

How it works:
  - Recursively scans the specified directory
  - Groups files with similar names using string similarity
  - Shows frequency of filenames, extensions, and base names
  - Reports groups of similar filenames together
`);
}

/**
 * Main function
 */
async function main() {
    const options = parseArguments();
    
    if (options.help || options.directory === null) {
        showHelp();
        return;
    }
    
    try {
        // Resolve the directory path
        const resolvedPath = path.resolve(options.directory);
        
        console.log(`Scanning directory: ${resolvedPath}`);
        console.log(`Similarity threshold: ${options.threshold}`);
        console.log('This may take a moment for large directories...\n');
        
        // Get all files
        const files = await getAllFiles(resolvedPath, options.includeHidden);
        
        if (files.length === 0) {
            console.log('No files found in the specified directory.');
            return;
        }
        
        // Extract just filenames for similarity analysis
        const filenames = files.map(file => file.filename);
        
        // Analyze patterns
        const analysis = analyzeFilenamePatterns(files);
        
        // Group similar filenames
        const similarGroups = groupSimilarFilenames(filenames, options.threshold);
        
        // Generate and display report
        const report = formatReport(files, analysis, similarGroups, options.threshold);
        console.log(report);
        
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
    groupSimilarFilenames,
    analyzeFilenamePatterns,
    formatReport
};