const data = require('./Adrian-commits.json');

// Analyze directory structure
const dirs = {};
data.commits.forEach((commit, i) => {
    commit.files.forEach(file => {
        // Extract directory from path
        const pathParts = file.path.replace(/\\/g, '/').split('/');
        const dir = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '.';
        if (!dirs[dir]) dirs[dir] = [];
        dirs[dir].push({
            commit: i+1, 
            file: file.filename, 
            date: file.date,
            originalFilename: file.originalFilename,
            path: file.path
        });
    });
});

console.log('Directories and file counts:');
Object.keys(dirs).sort().forEach(dir => {
    console.log(`${dir}: ${dirs[dir].length} files`);
});

console.log('\nFiles by directory with dates:');
Object.keys(dirs).sort().forEach(dir => {
    console.log(`\n${dir}:`);
    dirs[dir].sort((a, b) => new Date(a.date) - new Date(b.date))
        .forEach(f => console.log(`  Commit ${f.commit}: ${f.file} (${f.date}) [orig: ${f.originalFilename}]`));
});