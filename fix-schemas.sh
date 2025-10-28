#!/bin/bash

# Script to move original schema files to /public/schemas and create symlinks back
# This fixes Vercel build issues where symlinks don't work in the build environment

echo "Moving schema files to public directory and creating reverse symlinks..."

cd graph-editor/public/schemas

# Process each item in the schemas directory
for item in *; do
    if [ -L "$item" ]; then
        echo "Found symlink: $item"
        
        # Get the target path
        target=$(readlink "$item")
        echo "  -> points to: $target"
        
        # Check if target exists
        if [ -e "$target" ]; then
            # Remove the symlink
            rm "$item"
            echo "  -> removed symlink"
            
            # Move the actual file/directory to public
            if [ -d "$target" ]; then
                mv "$target" "$item"
                echo "  -> moved directory: $target -> $item"
            else
                mv "$target" "$item"
                echo "  -> moved file: $target -> $item"
            fi
            
            # Create reverse symlink from original location to public
            ln -s "../../graph-editor/public/schemas/$item" "$target"
            echo "  -> created reverse symlink: $target -> ../../graph-editor/public/schemas/$item"
        else
            echo "  -> ERROR: target does not exist: $target"
        fi
    else
        echo "Skipping non-symlink: $item"
    fi
done

echo "Schema file reorganization complete!"
