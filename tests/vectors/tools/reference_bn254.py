"""Small test-only BN254 G1 reference over the curve equation y²=x³+3."""

P = 21888242871839275222246405745257275088696311157297823662689037894645226208583
Q = 21888242871839275222246405745257275088548364400416034343698204186575808495617
IDENTITY = (0, 0)


def check_point(x: int, y: int) -> bool:
    if (x, y) == IDENTITY:
        return True
    return 0 <= x < P and 0 <= y < P and (y * y - x * x * x - 3) % P == 0


def negate(point: tuple[int, int]) -> tuple[int, int]:
    if point == IDENTITY:
        return point
    return point[0], (-point[1]) % P


def add(left: tuple[int, int], right: tuple[int, int]) -> tuple[int, int]:
    if not check_point(*left) or not check_point(*right):
        raise ValueError("noncanonical or off-curve point")
    if left == IDENTITY:
        return right
    if right == IDENTITY:
        return left
    x1, y1 = left
    x2, y2 = right
    if x1 == x2 and (y1 + y2) % P == 0:
        return IDENTITY
    slope = ((3 * x1 * x1) * pow(2 * y1, -1, P) if left == right
             else (y2 - y1) * pow((x2 - x1) % P, -1, P)) % P
    x3 = (slope * slope - x1 - x2) % P
    y3 = (slope * (x1 - x3) - y1) % P
    return x3, y3


def multiply(point: tuple[int, int], scalar: int) -> tuple[int, int]:
    if scalar < 0:
        return multiply(negate(point), -scalar)
    result = IDENTITY
    addend = point
    while scalar:
        if scalar & 1:
            result = add(result, addend)
        addend = add(addend, addend)
        scalar >>= 1
    return result
