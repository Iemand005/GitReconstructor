#!/usr/bin/env node

/**
 * Simple Node.js tool to get file modification dates
 * 
 * Usage:
 *   node simpleFileDateTool.js <filePath1> [filePath2] [filePath3]...
 */

const fs = require('fs');
const path = require('path');

/**
 * Get modification date of a file
 * @param {string} filePath - Path to the file
 * @returns {Date} - The modification date
 */
function getFileModifiedDate(filePath) {
    try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
            throw new Error(`Path is not a file: ${filePath}`);
        }
        return stats.mtime;
    } catch (error) {
        throw new Error(`Error getting modification date for ${filePath}: ${error.message}`);
    }
}

/**
 * Get modification dates for multiple files
 * @param {string[]} filePaths - Array of file paths
 * @returns {Object} - Object with file paths as keys and modification dates as values
 */
function getMultipleFileDates(filePaths) {
    const results = {};
    
    for (const filePath of filePaths) {
        try {
            results[filePath] = getFileModifiedDate(filePath);
        } catch (error) {
            console.error(`Warning: ${error.message}`);
            results[filePath] = null;
        }
    }
    
    return results;
}

// Main execution
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage: node simpleFileDateTool.js <filePath1> [filePath2] [filePath3]...');
        console.log('');
        console.log('Example: node simpleFileDateTool.js file.txt anotherFile.js');
        process.exit(1);
    }
    
    const fileDates = getMultipleFileDates(args);
    
    // Output results
    console.log('File Modification Dates:');
    console.log('='.repeat(50));
    
    Object.entries(fileDates).forEach(([filePath, date]) => {
        if (date) {
            const resolvedPath = path.resolve(filePath);
            console.log(`${resolvedPath}:`);
            console.log(`  Modified: ${date.toISOString()}`);
            console.log(`  Local:   ${date.toLocaleString()}`);
            console.log('');
        }
    });
}

// Export for use as a module
module.exports = {
    getFileModifiedDate,
    getMultipleFileDates
};