// Efficient circular buffer implementation to prevent memory growth
class CircularBuffer {
    constructor(capacity) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
        this.head = 0;
        this.tail = 0;
        this.size = 0;
    }

    push(item) {
        this.buffer[this.tail] = item;
        this.tail = (this.tail + 1) % this.capacity;
        
        if (this.size < this.capacity) {
            this.size++;
        } else {
            // Overwrite oldest element
            this.head = (this.head + 1) % this.capacity;
        }
        return true;
    }

    shift() {
        if (this.size === 0) {
            return undefined;
        }
        
        const item = this.buffer[this.head];
        this.buffer[this.head] = undefined; // Help GC
        this.head = (this.head + 1) % this.capacity;
        this.size--;
        return item;
    }

    peek() {
        if (this.size === 0) {
            return undefined;
        }
        return this.buffer[this.head];
    }

    clear() {
        this.buffer = new Array(this.capacity);
        this.head = 0;
        this.tail = 0;
        this.size = 0;
    }

    isEmpty() {
        return this.size === 0;
    }

    isFull() {
        return this.size === this.capacity;
    }

    getSize() {
        return this.size;
    }

    toArray() {
        const result = [];
        let index = this.head;
        for (let i = 0; i < this.size; i++) {
            result.push(this.buffer[index]);
            index = (index + 1) % this.capacity;
        }
        return result;
    }

    // Add splice-like functionality for compatibility
    splice(start, deleteCount) {
        if (start !== 0) {
            throw new Error('CircularBuffer splice only supports start index 0');
        }
        
        const result = [];
        const count = Math.min(deleteCount || this.size, this.size);
        
        for (let i = 0; i < count; i++) {
            result.push(this.shift());
        }
        
        return result;
    }

    // Compatibility property for array-like behavior
    get length() {
        return this.size;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CircularBuffer;
}