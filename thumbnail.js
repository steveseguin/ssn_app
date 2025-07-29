
function detectGameThumbnail(ctx, width, height) {
    // Check for title text at top and game logo/branding at bottom
    const hasTopTitle = detectTitleTextArea(ctx, width, height);
    const hasBottomLogo = checkForGameLogo(ctx, width, height);
    
    // Check for person/character silhouette in center
    const hasCentralFigure = detectCentralFigure(ctx, width, height);
    
    // Return true if we detect at least 2 of these characteristics
    return (hasTopTitle && hasBottomLogo) || 
           (hasTopTitle && hasCentralFigure) || 
           (hasBottomLogo && hasCentralFigure);
}

function detectCentralFigure(ctx, width, height) {
    // Check for a central figure (like a person silhouette)
    const centerX = Math.floor(width / 2);
    const centerWidth = Math.floor(width * 0.4);
    const startX = centerX - Math.floor(centerWidth / 2);
    const endX = startX + centerWidth;
    
    // Sample vertical bands to detect figure edges
    const verticalSamples = 10;
    let edgeChanges = 0;
    
    for (let i = 0; i < verticalSamples; i++) {
        const y = Math.floor(height * (0.3 + 0.4 * (i / verticalSamples)));
        let lastBrightness = -1;
        let changePoints = 0;
        
        for (let x = startX; x < endX; x += 4) {
            const pixel = ctx.getImageData(x, y, 1, 1).data;
            const brightness = getPixelBrightness(pixel);
            
            if (lastBrightness >= 0) {
                if (Math.abs(brightness - lastBrightness) > 30) {
                    changePoints++;
                }
            }
            
            lastBrightness = brightness;
        }
        
        // If we detect 2+ significant changes, could be figure outline
        if (changePoints >= 2) {
            edgeChanges++;
        }
    }
    
    return edgeChanges >= 4;
}

function detectVerticalBars(ctx, width, height, requireStrongerEvidence, parentDebug) {
    // Initialize debug info
    const debug = {
        leftBarInfo: null,
        rightBarInfo: null,
        barsMatch: false,
        hasSignificantBars: false,
        hasDistinctContent: false,
        requireStrongerEvidence: requireStrongerEvidence,
        minBarWidth: 0,
        minMatchCount: 0,
        reasons: []
    };
    
    // Sample more rows at various positions
    const yPositions = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    
    // Adjust minimum bar width based on evidence requirements
    const minRelativeBarWidth = requireStrongerEvidence ? 0.05 : 0.03;
    const minBarWidth = Math.max(4, Math.ceil(width * minRelativeBarWidth));
    debug.minBarWidth = minBarWidth;
    
    // Detect both black bars and color bars
    const leftBars = detectSideBars(ctx, width, height, yPositions, 'left', minBarWidth);
    const rightBars = detectSideBars(ctx, width, height, yPositions, 'right', minBarWidth);
    
    debug.leftBarInfo = {
        count: leftBars.count,
        median: leftBars.median,
        color: leftBars.color
    };
    
    debug.rightBarInfo = {
        count: rightBars.count,
        median: rightBars.median,
        color: rightBars.color
    };
    
    // Calculate minimum matches needed based on evidence requirements
    const minMatchCount = requireStrongerEvidence ? 5 : 3;
    debug.minMatchCount = minMatchCount;
    
    let hasVerticalBars = false;
    
    // Initial checks on match counts
    if (leftBars.count < minMatchCount) {
        debug.reasons.push(`Left bar detection insufficient: ${leftBars.count}/${minMatchCount} rows matched`);
    }
    
    if (rightBars.count < minMatchCount) {
        debug.reasons.push(`Right bar detection insufficient: ${rightBars.count}/${minMatchCount} rows matched`);
    }
    
    // If we have enough measurements and they're consistent
    if (leftBars.count >= minMatchCount && rightBars.count >= minMatchCount) {
        debug.reasons.push(`Found sufficient bar matches: Left=${leftBars.count}, Right=${rightBars.count}`);
        
        // Verify the bars are roughly the same width
        const widthRatio = Math.max(leftBars.median, rightBars.median) / 
                          Math.min(leftBars.median, rightBars.median);
        const widthsMatch = widthRatio < 3;
        debug.barsMatch = widthsMatch;
        
        if (!widthsMatch) {
            debug.reasons.push(`Bar widths don't match: Left=${leftBars.median}px, Right=${rightBars.median}px, Ratio=${widthRatio.toFixed(2)}`);
        } else {
            debug.reasons.push(`Bar widths match: Left=${leftBars.median}px, Right=${rightBars.median}px, Ratio=${widthRatio.toFixed(2)}`);
        }
        
        // Verify it's not a completely uniform image by checking center pixels
        const contentCheck = checkForContentInCenter(ctx, width, height, yPositions, 
                                             leftBars.color, rightBars.color);
        debug.hasDistinctContent = contentCheck.hasDistinctContent;
        debug.contentColorVariance = contentCheck.colorVariance;
        
        if (!contentCheck.hasDistinctContent) {
            debug.reasons.push(`No distinct content in center detected`);
        } else {
            debug.reasons.push(`Distinct content in center detected with variance: ${contentCheck.colorVariance.toFixed(2)}`);
        }
        
        // Additional check: bar widths should be proportional to image width
        const totalBarWidth = leftBars.median + rightBars.median;
        const barRatio = totalBarWidth / width;
        debug.barRatio = barRatio;
        
        // For standard ratios, bars should take up minimum percentage of width
        const barWidthThreshold = requireStrongerEvidence ? 0.1 : 0.06;
        const hasSignificantBars = barRatio >= barWidthThreshold;
        debug.hasSignificantBars = hasSignificantBars;
        
        if (!hasSignificantBars) {
            debug.reasons.push(`Bars not significant enough: ${(barRatio * 100).toFixed(2)}% of image width (threshold: ${(barWidthThreshold * 100).toFixed(2)}%)`);
        } else {
            debug.reasons.push(`Bars are significant: ${(barRatio * 100).toFixed(2)}% of image width`);
        }
        
        hasVerticalBars = widthsMatch && contentCheck.hasDistinctContent && hasSignificantBars;
    }
    
    // Special check for text at top (common in game thumbnails)
    const hasTitleText = detectTitleTextArea(ctx, width, height);
    debug.hasTitleText = hasTitleText;
    
    if (hasTitleText) {
        debug.reasons.push("Detected title text area (common in game thumbnails)");
        
        // Be extremely skeptical for game thumbnails
        if (hasVerticalBars) {
            const hasVeryStrongEvidence = leftBars.count >= 7 && rightBars.count >= 7;
            if (!hasVeryStrongEvidence) {
                debug.reasons.push("Overriding vertical bar detection due to game thumbnail characteristics");
                hasVerticalBars = false;
            }
        }
    }
    
    return {
        hasVerticalBars: hasVerticalBars,
        debug: debug
    };
}

function checkForContentInCenter(ctx, width, height, yPositions, leftColor, rightColor) {
    // Debug structure
    const result = {
        hasDistinctContent: false,
        colorVariance: 0,
        centerColors: []
    };
    
    const centerX = Math.floor(width / 2);
    const centerWidth = Math.floor(width * 0.3);
    const startX = Math.floor(width * 0.35);
    
    // Sample center points for color diversity
    const centerColors = [];
    for (const yRatio of yPositions) {
        const y = Math.floor(height * yRatio);
        
        for (let x = startX; x < startX + centerWidth; x += Math.ceil(centerWidth / 5)) {
            const pixel = ctx.getImageData(x, y, 1, 1).data;
            centerColors.push([pixel[0], pixel[1], pixel[2]]);
        }
    }
    
    result.centerColors = centerColors;
    
    // Check if center has distinct colors from edges
    let hasDistinctContent = false;
    for (const centerColor of centerColors) {
        if (!isSimilarColor(centerColor, leftColor, 30) && 
            !isSimilarColor(centerColor, rightColor, 30)) {
            hasDistinctContent = true;
            break;
        }
    }
    
    result.hasDistinctContent = hasDistinctContent;
    
    // Also check color variance in center
    const colorVariance = calculateColorVariance(centerColors);
    result.colorVariance = colorVariance;
    
    return result;
}

function detectTitleTextArea(ctx, width, height) {
    // Check for title text at top of image (common in game thumbnails)
    const topHeight = Math.floor(height * 0.15); // Top 15% of image
    
    // Check for high contrast pattern at top (text on background)
    let totalContrast = 0;
    const samplePoints = 20;
    
    for (let i = 0; i < samplePoints; i++) {
        const x1 = Math.floor(width * (0.1 + 0.8 * (i / samplePoints)));
        const y1 = Math.floor(height * 0.05);
        
        const x2 = Math.floor(width * (0.1 + 0.8 * ((i+1) / samplePoints)));
        const y2 = Math.floor(height * 0.1);
        
        const pixel1 = ctx.getImageData(x1, y1, 1, 1).data;
        const pixel2 = ctx.getImageData(x2, y2, 1, 1).data;
        
        // Calculate contrast between pixels
        const contrast = Math.abs(getPixelBrightness(pixel1) - getPixelBrightness(pixel2));
        totalContrast += contrast;
    }
    
    // High average contrast suggests text
    const avgContrast = totalContrast / samplePoints;
    return avgContrast > 30;
}

function checkForGameLogo(ctx, width, height) {
    // Check bottom third of image for logo-like features (high contrast, clean edges)
    const bottomThird = Math.floor(height * 0.65);
    const sampleWidth = Math.floor(width * 0.7);
    const startX = Math.floor(width * 0.15);
    
    let contrastPoints = 0;
    const yPositions = [0.7, 0.75, 0.8, 0.85, 0.9];
    
    for (const yRatio of yPositions) {
        const y = Math.floor(height * yRatio);
        let lastBrightness = -1;
        let contrastChanges = 0;
        
        for (let x = startX; x < startX + sampleWidth; x += 4) {
            const pixel = ctx.getImageData(x, y, 1, 1).data;
            const brightness = getPixelBrightness(pixel);
            
            if (lastBrightness >= 0) {
                if (Math.abs(brightness - lastBrightness) > 25) {
                    contrastChanges++;
                }
            }
            
            lastBrightness = brightness;
        }
        
        if (contrastChanges >= 3) {
            contrastPoints++;
        }
    }
    
    return contrastPoints >= 2;
}

function getPixelBrightness(pixel) {
    // Calculate perceived brightness of a pixel
    return (pixel[0] * 0.299 + pixel[1] * 0.587 + pixel[2] * 0.114);
}

function calculateColorVariance(colors) {
    if (colors.length <= 1) return 0;
    
    // Calculate average RGB values
    let sumR = 0, sumG = 0, sumB = 0;
    for (const color of colors) {
        sumR += color[0];
        sumG += color[1];
        sumB += color[2];
    }
    
    const avgR = sumR / colors.length;
    const avgG = sumG / colors.length;
    const avgB = sumB / colors.length;
    
    // Calculate variance
    let variance = 0;
    for (const color of colors) {
        const diffR = color[0] - avgR;
        const diffG = color[1] - avgG;
        const diffB = color[2] - avgB;
        
        variance += (diffR * diffR + diffG * diffG + diffB * diffB);
    }
    
    return variance / colors.length;
}

function detectSideBars(ctx, width, height, yPositions, side, minBarWidth) {
    const barWidths = [];
    const colorSamples = [];
    const isLeft = side === 'left';
    const edgeLimit = Math.floor(width * (isLeft ? 0.3 : 0.7));
    
    for (const yRatio of yPositions) {
        const y = Math.floor(height * yRatio);
        let barWidth = 0;
        let barColor = null;
        
        if (isLeft) {
            // Left side edge detection
            const startPixel = ctx.getImageData(0, y, 1, 1).data;
            barColor = [startPixel[0], startPixel[1], startPixel[2]];
            
            // Skip text detection for top rows (where text is likely)
            const isTopRow = yRatio <= 0.2;
            const textTolerance = isTopRow ? 35 : 20;
            
            for (let x = 0; x < edgeLimit; x++) {
                const pixel = ctx.getImageData(x, y, 1, 1).data;
                if (isSimilarColor(pixel, barColor, textTolerance) || 
                    isGradientVariation(pixel, barColor, x, 30)) {
                    barWidth++;
                } else {
                    break;
                }
            }
        } else {
            // Right side edge detection
            const startPixel = ctx.getImageData(width - 1, y, 1, 1).data;
            barColor = [startPixel[0], startPixel[1], startPixel[2]];
            
            const isTopRow = yRatio <= 0.2;
            const textTolerance = isTopRow ? 35 : 20;
            
            for (let x = width - 1; x > edgeLimit; x--) {
                const pixel = ctx.getImageData(x, y, 1, 1).data;
                if (isSimilarColor(pixel, barColor, textTolerance) || 
                    isGradientVariation(pixel, barColor, width - x, 30)) {
                    barWidth++;
                } else {
                    break;
                }
            }
        }
        
        if (barWidth >= minBarWidth) {
            barWidths.push(barWidth);
            colorSamples.push(barColor);
        }
    }
    
    return {
        count: barWidths.length,
        median: getMedian(barWidths),
        color: getMostCommonColor(colorSamples)
    };
}

function isSimilarColor(pixel, referenceColor, threshold) {
    return Math.abs(pixel[0] - referenceColor[0]) <= threshold &&
           Math.abs(pixel[1] - referenceColor[1]) <= threshold &&
           Math.abs(pixel[2] - referenceColor[2]) <= threshold;
}

function isGradientVariation(pixel, referenceColor, position, maxVariation) {
    // Allow for gradual changes in color based on position
    const gradientFactor = Math.min(1, position / 20);
    const threshold = Math.ceil(maxVariation * gradientFactor);
    
    return Math.abs(pixel[0] - referenceColor[0]) <= threshold &&
           Math.abs(pixel[1] - referenceColor[1]) <= threshold &&
           Math.abs(pixel[2] - referenceColor[2]) <= threshold;
}

function getMostCommonColor(colorSamples) {
    if (colorSamples.length === 0) return [0, 0, 0];
    
    // Group similar colors
    const groups = [];
    const threshold = 20;
    
    for (const color of colorSamples) {
        let foundGroup = false;
        
        for (const group of groups) {
            if (isSimilarColor(color, group.color, threshold)) {
                group.count++;
                foundGroup = true;
                break;
            }
        }
        
        if (!foundGroup) {
            groups.push({ color, count: 1 });
        }
    }
    
    // Find the most common color group
    let maxCount = 0;
    let dominantColor = colorSamples[0];
    
    for (const group of groups) {
        if (group.count > maxCount) {
            maxCount = group.count;
            dominantColor = group.color;
        }
    }
    
    return dominantColor;
}

function getMedian(values) {
    if (values.length === 0) return 0;
    
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    
    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    } else {
        return sorted[middle];
    }
}
