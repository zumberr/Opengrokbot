from PIL import Image
import os

png_path = "/home/ubuntu/OpenMausBot/build/icon-1024.png"
ico_path = "/home/ubuntu/OpenMausBot/build/icon.ico"

if os.path.exists(png_path):
    img = Image.open(png_path)
    img.save(ico_path, format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (32, 32), (16, 16)])
    print("ICO generated successfully.")
else:
    print("PNG icon not found.")
