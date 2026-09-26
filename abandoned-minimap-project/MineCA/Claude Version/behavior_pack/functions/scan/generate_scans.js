// Generate terrain scan functions for different zoom levels
const fs = require('fs');

const sizes = [
    { size: 11, name: 'terrain_11x11.mcfunction' },
    { size: 15, name: 'terrain_15x15.mcfunction' },
    { size: 31, name: 'terrain_31x31.mcfunction' },
    { size: 41, name: 'terrain_41x41.mcfunction' },
    { size: 51, name: 'terrain_51x51.mcfunction' },
    { size: 71, name: 'terrain_71x71.mcfunction' },
    { size: 101, name: 'terrain_101x101.mcfunction' }
];

sizes.forEach(({ size, name }) => {
    const radius = Math.floor(size / 2);
    let content = `# Scan ${size}x${size} grid around player (${size * size} blocks)\n`;
    content += `# Generated pattern from -${radius} to +${radius} in both X and Z\n\n`;
    
    for (let z = -radius; z <= radius; z++) {
        content += `# Row ${z}\n`;
        for (let x = -radius; x <= radius; x++) {
            content += `gettopsolidblock ~${x} 200 ~${z}\n`;
        }
        content += '\n';
    }
    
    fs.writeFileSync(name, content);
    console.log(`Generated ${name}`);
});

console.log('All terrain scan functions generated!');
