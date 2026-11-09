
export interface OutfitExtractionResponse {
    items: ClothingItem[];
    item_count: number;
    image_url: string;
    extracted_at: string;
    image_dimensions: { width: number, height: number };
}

export interface ClothingItem {
    label: string;
    category: ClothingItemCategory;
    subcategory: ClothingItemSubcategory;
    color: string;
    pattern: ClothingItemPattern;
    style_tags: string[];
    confidence: ExtractionConfidence;
    bounding_box: OutfitBoundingBox;
    isolated_image_url?: string;
}


export enum ExtractionConfidence {
    HIGH = 'high',
    MEDIUM = 'medium',
    LOW = 'low',
}

export interface OutfitBoundingBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export enum ClothingItemPattern {
    SOLID = 'solid',
    STRIPED = 'striped',
    CHECKED = 'checked',
    GRAPHIC = 'graphic',
    CAMO = 'camo',
    FLORAL = 'floral',
    OTHER = 'other',
}

export enum ClothingItemCategory {
    TOP = 'top',
    BOTTOM = 'bottom',
    OUTERWEAR = 'outerwear',
    FOOTWEAR = 'footwear',
    FULL_BODY = 'full-body',
    ACCESSORY = 'accessory',
}

export enum ClothingItemSubcategory {
    // Tops
    T_SHIRT = 't-shirt',
    SHIRT = 'shirt',              // Button-downs, blouses, collared shirts
    SWEATER = 'sweater',            // Knitwear, pullovers
    HOODIE = 'hoodie',
    SWEATSHIRT = 'sweatshirt',
    TANK_TOP = 'tank-top',
    POLO = 'polo',
    CROP_TOP = 'crop-top',

    // Bottoms
    JEANS = 'jeans',
    PANTS = 'pants',              // Chinos, trousers, slacks, cargos
    SHORTS = 'shorts',
    SKIRT = 'skirt',
    SWEATPANTS = 'sweatpants',
    LEGGINGS = 'leggings',

    // Outerwear
    JACKET = 'jacket',            // Bomber, denim, leather, windbreaker
    COAT = 'coat',              // Trench, overcoat, puffer, parka
    BLAZER = 'blazer',
    VEST = 'vest',
    CARDIGAN = 'cardigan',

    // Footwear
    SNEAKERS = 'sneakers',
    BOOTS = 'boots',
    LOAFERS = 'loafers',
    HEELS = 'heels',
    FLATS = 'flats',
    SANDALS = 'sandals',
    SLIPPERS = 'slippers',

    // Full-Body
    DRESS = 'dress',
    JUMPSUIT = 'jumpsuit',        // Jumpsuits, rompers, overalls
    SUIT = 'suit',              // Full suits, co-ord sets

    // Accessories
    BAG = 'bag',                // Backpacks, handbags, totes, clutches
    JEWELRY = 'jewelry',          // Necklaces, rings, earrings, bracelets
    HAT = 'hat',                // Caps, beanies, bucket hats
    EYEWEAR = 'eyewear',          // Sunglasses, prescription glasses
    BELT = 'belt',
    SCARF = 'scarf',
    WATCH = 'watch',
    SOCKS = 'socks',
    GLOVES = 'gloves',

    // Fallback
    OTHER = 'other',
}

