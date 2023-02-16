import string
import random
import sys

def generate_password(length=12):
    # 选择的字符集包括大写字母，小写字母，数字和指定的特殊字符
    chars = string.ascii_uppercase + string.ascii_lowercase + string.digits + '.!-@%'
    special_chars = '.!-@%'
    password = ''
    # 先生成数字和字母
    for i in range(length-2):
        password += random.choice(string.ascii_uppercase + string.ascii_lowercase + string.digits)
    # 再添加少于3个特殊字符
    for i in range(min(3, length-len(password))):
        password += random.choice(special_chars)
    # 打乱生成的密码
    password = ''.join(random.sample(password, len(password)))
    return password

if __name__ == '__main__':
    length = 12
    if len(sys.argv) > 1:
        length = int(sys.argv[1])
    print(generate_password(length))
