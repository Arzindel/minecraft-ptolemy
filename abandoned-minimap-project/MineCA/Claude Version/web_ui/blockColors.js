// Block color mappings for minimap
// Format: 'block_name': 'hex_color'

const BLOCK_COLORS = {
    // Stone types
    'stone': '#7a7a7a',
    'cobblestone': '#808080',
    'mossy_cobblestone': '#627a62',
    'stone_bricks': '#7b7b7b',
    'andesite': '#8c8c8c',
    'diorite': '#c0c0c0',
    'granite': '#9a6e5b',
    'deepslate': '#4a4a4a',
    'tuff': '#5e6a63',
    'calcite': '#e0e0e0',
    
    // Dirt and grass
    'dirt': '#8b5a3c',
    'coarse_dirt': '#7a4f33',
    'grass': '#5dab3d',
    'grass_block': '#5dab3d',
    'podzol': '#6b5d45',
    'mycelium': '#6f6176',
    'mud': '#41393f',
    'muddy_mangrove_roots': '#3d3532',
    
    // Sand
    'sand': '#dbd3a0',
    'red_sand': '#be6a3b',
    'sandstone': '#d0c195',
    'red_sandstone': '#b35a2c',
    'gravel': '#7e7574',
    
    // Wood
    'oak_log': '#6e5331',
    'oak_planks': '#9f814f',
    'spruce_log': '#4a3319',
    'spruce_planks': '#6e5330',
    'birch_log': '#d7d7d7',
    'birch_planks': '#d1bc8a',
    'jungle_log': '#5a4a2a',
    'jungle_planks': '#9f7f4f',
    'acacia_log': '#6a5140',
    'acacia_planks': '#a86e3c',
    'dark_oak_log': '#3d2a1a',
    'dark_oak_planks': '#4a3319',
    'mangrove_log': '#7a3e32',
    'mangrove_planks': '#7d3f32',
    'cherry_log': '#372a29',
    'cherry_planks': '#e5b29c',
    
    // Leaves
    'oak_leaves': '#4e9e3d',
    'spruce_leaves': '#3b5f3c',
    'birch_leaves': '#65944a',
    'jungle_leaves': '#3c7e2d',
    'acacia_leaves': '#5e9e45',
    'dark_oak_leaves': '#3a5e2d',
    'mangrove_leaves': '#6e9e2d',
    'cherry_leaves': '#f5c4d0',
    'azalea_leaves': '#5c8f4d',
    
    // Ores
    'coal_ore': '#6a6a6a',
    'iron_ore': '#a28277',
    'copper_ore': '#8f6a59',
    'gold_ore': '#c7b569',
    'diamond_ore': '#6dd3d3',
    'emerald_ore': '#4eb75e',
    'lapis_ore': '#2c5c9e',
    'redstone_ore': '#9e2c2c',
    
    // Deep ores
    'deepslate_coal_ore': '#4a4a4a',
    'deepslate_iron_ore': '#6a5d5d',
    'deepslate_copper_ore': '#5d4a45',
    'deepslate_gold_ore': '#7a6d45',
    'deepslate_diamond_ore': '#4a7a7a',
    'deepslate_emerald_ore': '#3d7a4a',
    'deepslate_lapis_ore': '#2c4a7a',
    'deepslate_redstone_ore': '#7a2c2c',
    
    // Water and ice
    'water': '#3f76e4',
    'ice': '#9bd4ff',
    'packed_ice': '#8bc5ff',
    'blue_ice': '#7ab4ff',
    'snow': '#ffffff',
    'snow_block': '#fffefe',
    
    // Plants
    'tall_grass': '#5dab3d',
    'fern': '#4a8f32',
    'dead_bush': '#946428',
    'seagrass': '#3d7a3d',
    'kelp': '#4a8f4a',
    'bamboo': '#5e8f2d',
    'cactus': '#587d3e',
    'sugar_cane': '#7dab5a',
    
    // Flowers
    'dandelion': '#ffd83d',
    'poppy': '#ed302c',
    'blue_orchid': '#2cbeed',
    'allium': '#b878ed',
    'azure_bluet': '#e7f2df',
    'tulip': '#ffa500',
    'oxeye_daisy': '#d0e8df',
    'sunflower': '#ffdc3d',
    'rose_bush': '#ff4545',
    
    // Nether
    'netherrack': '#6e3434',
    'nether_bricks': '#2c1616',
    'soul_sand': '#564336',
    'soul_soil': '#4a3729',
    'glowstone': '#f9d49c',
    'magma': '#7a3e1a',
    'basalt': '#5c5d68',
    'blackstone': '#2a2631',
    'crimson_nylium': '#9e3d3d',
    'warped_nylium': '#3d7a7a',
    
    // End
    'end_stone': '#e0e0c0',
    'end_stone_bricks': '#d0d0b0',
    'purpur_block': '#a77fa7',
    'purpur_pillar': '#9e6f9e',
    
    // Concrete
    'white_concrete': '#d0d0d0',
    'light_gray_concrete': '#9d9d97',
    'gray_concrete': '#4c4c4c',
    'black_concrete': '#080a0f',
    'brown_concrete': '#603b1f',
    'red_concrete': '#8e2121',
    'orange_concrete': '#e15f1a',
    'yellow_concrete': '#f8c527',
    'lime_concrete': '#5fcc22',
    'green_concrete': '#495b24',
    'cyan_concrete': '#158991',
    'light_blue_concrete': '#2389c6',
    'blue_concrete': '#2c2e8f',
    'purple_concrete': '#641f9e',
    'magenta_concrete': '#a72d6e',
    'pink_concrete': '#d5658f',
    
    // Wool
    'white_wool': '#e9e9e9',
    'light_gray_wool': '#a0a7a7',
    'gray_wool': '#4a4a4a',
    'black_wool': '#1a1a1a',
    'brown_wool': '#6e4a2f',
    'red_wool': '#9e2b27',
    'orange_wool': '#e67a22',
    'yellow_wool': '#f4b41b',
    'lime_wool': '#6fcc2f',
    'green_wool': '#576f2d',
    'cyan_wool': '#1a8e91',
    'light_blue_wool': '#3a9ecc',
    'blue_wool': '#313d99',
    'purple_wool': '#7724a0',
    'magenta_wool': '#b0309a',
    'pink_wool': '#e68da8',
    
    // Terracotta
    'terracotta': '#985e45',
    'white_terracotta': '#d0a896',
    'light_gray_terracotta': '#8f6a5e',
    'gray_terracotta': '#573d33',
    'black_terracotta': '#251610',
    'brown_terracotta': '#4c3223',
    'red_terracotta': '#8f3c2e',
    'orange_terracotta': '#a14e2d',
    'yellow_terracotta': '#ba8524',
    'lime_terracotta': '#667534',
    'green_terracotta': '#4c5234',
    'cyan_terracotta': '#565961',
    'light_blue_terracotta': '#706c8a',
    'blue_terracotta': '#4a3c5a',
    'purple_terracotta': '#764656',
    'magenta_terracotta': '#955166',
    'pink_terracotta': '#a14e54',
    
    // Glass
    'glass': '#c0e8ff',
    'white_stained_glass': '#ffffff',
    'light_gray_stained_glass': '#a0a7a7',
    'gray_stained_glass': '#4a4a4a',
    'black_stained_glass': '#1a1a1a',
    
    // Misc
    'bedrock': '#525252',
    'obsidian': '#100f1f',
    'crying_obsidian': '#3d1f5f',
    'clay': '#9ca2ab',
    'moss_block': '#5a6e3d',
    'dripstone_block': '#8a6959',
    'prismarine': '#5f9d8f',
    'sponge': '#c6c647',
    'slime_block': '#6eb847',
    'honey_block': '#f0841c',
    'hay_block': '#b39646',
    'melon': '#7a9e2c',
    'pumpkin': '#c17025',
    
    // Default fallback
    'unknown': '#808080'
};

// Get color for a block type
function getBlockColor(blockType) {
    // Remove minecraft: prefix if present
    const cleanType = blockType.replace('minecraft:', '');
    
    // Return color or default
    return BLOCK_COLORS[cleanType] || BLOCK_COLORS['unknown'];
}

// Get item icon color (for inventory)
function getItemColor(itemType) {
    // For now, use block colors
    // In the future, this could be extended with item-specific colors
    return getBlockColor(itemType);
}
