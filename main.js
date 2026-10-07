#!/usr/bin/env node

/**
 * GitReconstructor - Main entry point
 * This project provides tools for working with file metadata, including modification dates.
 */

const { getFileModifiedDate, getMultipleFileDates } = require('./simpleFileDateTool');
const advancedTool = require('./getFileModificationDate');

// Example usage
console.log('GitReconstructor - File Modification Date Tools');
console.log('='.repeat(50));

// Simple example
try {
    const date = getFileModifiedDate(__filename);
    console.log(`This file (${__filename}) was last modified: ${date.toLocaleString()}`);
    console.log(`ISO format: ${date.toISOString()}`);
} catch (error) {
    console.error('Error:', error.message);
}

console.log('\nAvailable tools:');
console.log('1. simpleFileDateTool.js - Basic file date retrieval');
console.log('2. getFileModificationDate.js - Advanced tool with directory and glob support');

console.log('\nRun with:');
console.log('  node simpleFileDateTool.js <filePaths>');
console.log('  node getFileModificationDate.js <path> [--recursive] [--json]');