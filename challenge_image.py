import secrets,hashlib,struct,zlib,base64,math

def render_challenge(token, odd):
    (w, h) = (210, 150)
    background = secrets.choice(((239, 243, 245), (245, 241, 233), (236, 242, 238)))
    grain = secrets.token_bytes(w * h)
    pixels = bytearray(w * h * 3)
    for (i, noise) in enumerate(grain):
        delta = noise % 7 - 3
        pixels[i * 3:i * 3 + 3] = bytes((max(0, min(255, c + delta)) for c in background))

    def dot(x, y, color, opacity=1):
        if 0 <= x < w and 0 <= y < h:
            start = (y * w + x) * 3
            pixels[start:start + 3] = bytes((round(pixels[start + n] * (1 - opacity) + color[n] * opacity) for n in range(3)))
    common = secrets.randbelow(3)
    different = (common + 1 + secrets.randbelow(2)) % 3
    base_ink = secrets.choice(((44, 75, 96), (60, 77, 63), (88, 69, 49)))
    for cell in range(9):
        cx = 35 + cell % 3 * 70 + secrets.randbelow(17) - 8
        cy = 25 + cell // 3 * 50 + secrets.randbelow(7) - 3
        radius = 11 + secrets.randbelow(41) / 10
        rotation = (secrets.randbelow(31) - 15) / 100
        (cosine, sine) = (math.cos(rotation), math.sin(rotation))
        shape = different if cell == odd else common
        ink = tuple((max(0, min(255, c + secrets.randbelow(17) - 8)) for c in base_ink))
        vertices = [(radius * 1.15 * math.cos(-math.pi / 2 + i * 2 * math.pi / 3), radius * 1.15 * math.sin(-math.pi / 2 + i * 2 * math.pi / 3)) for i in range(3)] if shape == 1 else []
        extent = math.ceil(radius * 1.4)
        for y in range(-extent, extent + 1):
            for x in range(-extent, extent + 1):
                px = x * cosine + y * sine
                py = -x * sine + y * cosine
                if shape == 0:
                    distance = radius - math.hypot(px, py)
                elif shape == 2:
                    distance = min(radius * 0.82 - abs(px), radius * 0.82 - abs(py))
                else:
                    distance = min((((vertices[(i + 1) % 3][0] - a) * (py - b) - (vertices[(i + 1) % 3][1] - b) * (px - a)) / math.dist((a, b), vertices[(i + 1) % 3]) for (i, (a, b)) in enumerate(vertices)))
                if distance > -0.6:
                    dot(cx + x, cy + y, ink, min(1, max(0, distance + 0.6)))
    for _ in range(5):
        x0 = secrets.randbelow(w)
        y0 = secrets.randbelow(h)
        span = 25 + secrets.randbelow(45)
        for step in range(span):
            x = x0 + step
            y = round(y0 + 2 * math.sin(step / 9))
            dot(x, y, base_ink, 0.07)
    for x in (70, 140):
        for y in range(h):
            dot(x, y, (207, 216, 218), 0.65)
    for y in (50, 100):
        for x in range(w):
            dot(x, y, (207, 216, 218), 0.65)
    raw = b''.join((b'\x00' + bytes(pixels[y * w * 3:(y + 1) * w * 3]) for y in range(h)))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 4294967295)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
    return {'challenge_id': token, 'image': 'data:image/png;base64,' + base64.b64encode(png).decode(), 'instruction': '点击与其他图案不同的一项', 'type': 'pattern'}
