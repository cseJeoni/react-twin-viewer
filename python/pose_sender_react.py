#!/usr/bin/env python3
import rclpy
from rclpy.node import Node
from tf2_ros import Buffer, TransformListener
from geometry_msgs.msg import TransformStamped
import requests, time

SERVER = "http://192.168.219.196:8000"
POST_URL = f"{SERVER}/pose"

class PoseSenderTF(Node):
    def __init__(self):
        super().__init__('pose_sender_tf_map_base')
        self.buffer = Buffer()
        self.listener = TransformListener(self.buffer, self)
        self.alpha = 0.2  # 저역통과 필터 강도(0.1~0.3 추천)
        self.fx = None
        self.fy = None

    def step(self):
        try:
            # map 좌표계에서 base_link 포즈(= 부드럽고 절대 정합) 
            # time=0.0은 "latest available" 의미
            trans: TransformStamped = self.buffer.lookup_transform(
                'map', 'base_link', rclpy.time.Time())
            x = float(trans.transform.translation.x)
            y = float(trans.transform.translation.y)

            # (선택) 1차 IIR 저역통과로 한 번 더 매끈하게
            if self.fx is None:
                self.fx, self.fy = x, y
            else:
                self.fx = self.alpha * x + (1 - self.alpha) * self.fx
                self.fy = self.alpha * y + (1 - self.alpha) * self.fy

            requests.post(POST_URL, json={"x": self.fx, "y": self.fy}, timeout=0.2)
        except Exception as e:
            # TF 준비 안 됐거나 네트워크 문제면 그냥 스킵
            pass

def main():
    rclpy.init()
    node = PoseSenderTF()
    try:
        # 40~60Hz 권장
        period = 1.0 / 50.0
        while rclpy.ok():
            rclpy.spin_once(node, timeout_sec=0.0)
            node.step()
            time.sleep(period)
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()
